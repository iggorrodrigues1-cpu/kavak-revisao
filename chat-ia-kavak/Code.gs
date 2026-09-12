/**
 * ============================================================================
 * CHAT IA KAVAK
 * Web App em Google Apps Script que cruza dados de dezenas/centenas de
 * planilhas do Google Drive corporativo e responde perguntas de negócio via
 * LLM, com roteamento em 2 passos (RAG leve) e memória de correções
 * (few-shot learning dinâmico).
 * ============================================================================
 *
 * INSTALAÇÃO RÁPIDA
 * 1. Abra script.google.com > Novo projeto (ou vincule a uma planilha).
 * 2. Cole este arquivo como Code.gs e o Index.html como Index.html.
 * 3. Configure as Script Properties (Extensões > Propriedades do projeto):
 *      - LLM_API_KEY     -> chave da API do provedor de LLM usado
 *      - LLM_PROVIDER    -> "anthropic" (default; outros exigem implementação)
 *      - MEMORY_SHEET_ID -> ID da planilha-mestre de Memória/Aprendizado
 *      - CATALOG_SHEET_ID -> ID da planilha que contém o catálogo de fontes
 *        (ver seção 2 abaixo). Suporta 100+ planilhas sem tocar no código.
 * 4. Preencha a planilha de catálogo com as 100+ fontes de dados da Kavak.
 * 5. Implantar > Nova implantação > Web App > Executar como "Eu" /
 *    Quem pode acessar "Qualquer pessoa na organização Kavak".
 */

// ---------------------------------------------------------------------------
// CONFIGURAÇÃO
// ---------------------------------------------------------------------------

const MAX_ROWS_PER_SHEET = 300;       // proteção contra prompts gigantes por fonte
const MAX_SOURCES_PER_QUERY = 2;      // quantas planilhas o roteador pode escolher
const MEMORY_SHEET_NAME = 'Memoria';
const CATALOG_SHEET_NAME = 'Catalogo';
const CATALOG_CACHE_KEY = 'kavak_catalog_cache_v1';
const CATALOG_CACHE_TTL_SECONDS = 21600; // 6h — catálogo muda pouco

function getScriptProp_(key, fallback) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  return value || fallback;
}

// ---------------------------------------------------------------------------
// WEB APP ENTRY POINT
// ---------------------------------------------------------------------------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Chat IA Kavak')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------------------------------------------------------------------------
// CATÁLOGO DE FONTES (METADADOS LEVES — SUPORTA 100+ PLANILHAS)
// ---------------------------------------------------------------------------

/**
 * O catálogo é a própria planilha de metadados (não o código-fonte), o que
 * permite cadastrar/editar centenas de fontes sem tocar no Apps Script.
 *
 * Estrutura esperada na aba CATALOG_SHEET_NAME da planilha CATALOG_SHEET_ID:
 * | chave | spreadsheet_id | aba | descricao | colunas_principais | chave_cruzamento |
 *
 * - chave: apelido curto e único da fonte (ex: "vendas_sp")
 * - spreadsheet_id: ID da planilha de negócio
 * - aba: nome da aba a ler
 * - descricao: frase explicando o que a planilha contém (usada pelo roteador)
 * - colunas_principais: lista de colunas relevantes, separadas por vírgula
 * - chave_cruzamento: coluna usada para joins com outras fontes (opcional)
 */
function loadCatalog_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CATALOG_CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const catalogId = getScriptProp_('CATALOG_SHEET_ID', '');
  if (!catalogId) throw new Error('CATALOG_SHEET_ID não configurado nas Script Properties.');

  const ss = SpreadsheetApp.openById(catalogId);
  const sheet = ss.getSheetByName(CATALOG_SHEET_NAME) || ss.getSheets()[0];
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length <= 1) return [];

  const headers = values[0].map(h => String(h).trim().toLowerCase());
  const idx = {
    chave: headers.indexOf('chave'),
    spreadsheetId: headers.indexOf('spreadsheet_id'),
    aba: headers.indexOf('aba'),
    descricao: headers.indexOf('descricao'),
    colunas: headers.indexOf('colunas_principais'),
    chaveCruzamento: headers.indexOf('chave_cruzamento'),
  };

  const catalog = values.slice(1)
    .filter(row => row[idx.chave])
    .map(row => ({
      chave: row[idx.chave],
      spreadsheetId: row[idx.spreadsheetId],
      aba: row[idx.aba],
      descricao: row[idx.descricao],
      colunasPrincipais: row[idx.colunas],
      chaveCruzamento: row[idx.chaveCruzamento],
    }));

  cache.put(CATALOG_CACHE_KEY, JSON.stringify(catalog), CATALOG_CACHE_TTL_SECONDS);
  return catalog;
}

/**
 * Monta o texto leve do catálogo (apenas metadados, nunca os dados em si)
 * para o LLM decidir, no Passo 1, quais fontes consultar.
 */
function buildCatalogPromptBlock_(catalog) {
  return catalog.map(c =>
    `- chave: "${c.chave}" | descrição: ${c.descricao} | colunas principais: ${c.colunasPrincipais}`
  ).join('\n');
}

// ---------------------------------------------------------------------------
// PASSO 1 — ROTEAMENTO (escolhe 1-2 fontes a partir do catálogo leve)
// ---------------------------------------------------------------------------

/**
 * Pergunta ao LLM, usando SOMENTE o catálogo de metadados (leve, nunca os
 * dados das planilhas), quais chaves de fonte respondem à pergunta do
 * usuário. Retorna um array de até MAX_SOURCES_PER_QUERY chaves válidas.
 */
function routeToSources_(userMessage, catalog) {
  const catalogBlock = buildCatalogPromptBlock_(catalog);
  const validKeys = new Set(catalog.map(c => c.chave));

  const routingSystemPrompt =
    'Você é um roteador de dados. Não responda à pergunta do usuário. ' +
    'Sua única tarefa é escolher, entre as fontes abaixo, quais contêm os ' +
    `dados necessários para respondê-la (no máximo ${MAX_SOURCES_PER_QUERY}). ` +
    'Responda APENAS um JSON no formato {"fontes": ["chave1", "chave2"]}, ' +
    'sem nenhum texto adicional.\n\nFONTES DISPONÍVEIS:\n' + catalogBlock;

  const raw = callLLM_(routingSystemPrompt, userMessage, { maxTokens: 200 });

  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (e) {
    parsed = { fontes: [] };
  }

  const fontes = Array.isArray(parsed.fontes) ? parsed.fontes : [];
  return fontes.filter(k => validKeys.has(k)).slice(0, MAX_SOURCES_PER_QUERY);
}

// ---------------------------------------------------------------------------
// PASSO 2 — LEITURA DIRECIONADA (abre e lê somente as fontes escolhidas)
// ---------------------------------------------------------------------------

/**
 * Lê apenas a aba/linhas necessárias de UMA fonte do catálogo, usando
 * getDisplayValues() (mais leve que getValues() para texto/prompt, evita
 * problemas de formatação de datas/números) e limitando a quantidade de
 * linhas trazidas.
 */
function readSourceData_(sourceEntry) {
  if (!sourceEntry || !sourceEntry.spreadsheetId) return null;

  const ss = SpreadsheetApp.openById(sourceEntry.spreadsheetId);
  const sheet = sourceEntry.aba ? ss.getSheetByName(sourceEntry.aba) : ss.getSheets()[0];
  if (!sheet) return null;

  const lastRow = Math.min(sheet.getLastRow(), MAX_ROWS_PER_SHEET + 1); // +1 = cabeçalho
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return [];

  const values = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  if (values.length === 0) return [];

  const headers = values[0].map(h => String(h).trim());
  const rows = values.slice(1);

  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

/**
 * Cruza duas listas de objetos por uma chave comum (ex: "placa", "sku").
 * LEFT JOIN de leftRows com rightRows.
 */
function joinByKey_(leftRows, rightRows, key) {
  const rightIndex = {};
  rightRows.forEach(r => {
    const k = r[key];
    if (k !== undefined) rightIndex[k] = r;
  });

  return leftRows.map(l => {
    const match = rightIndex[l[key]] || {};
    return Object.assign({}, l, match);
  });
}

/**
 * Executa o Passo 2 completo: lê cada fonte escolhida no roteamento e, se
 * duas fontes compartilharem chave_cruzamento, cruza os dados entre elas.
 */
function buildTargetedContext_(sourceKeys, catalog) {
  const byKey = {};
  catalog.forEach(c => { byKey[c.chave] = c; });

  const dataBySource = {};
  sourceKeys.forEach(key => {
    const entry = byKey[key];
    if (!entry) return;
    dataBySource[key] = { entry: entry, rows: readSourceData_(entry) || [] };
  });

  // Cruzamento automático quando exatamente 2 fontes compartilham a mesma
  // chave_cruzamento configurada no catálogo.
  const keys = Object.keys(dataBySource);
  if (keys.length === 2) {
    const [a, b] = keys;
    const keyA = dataBySource[a].entry.chaveCruzamento;
    const keyB = dataBySource[b].entry.chaveCruzamento;
    if (keyA && keyA === keyB) {
      dataBySource[a].rows = joinByKey_(dataBySource[a].rows, dataBySource[b].rows, keyA);
    }
  }

  return keys.map(key =>
    `### Fonte: ${key} (${dataBySource[key].entry.descricao})\n` + JSON.stringify(dataBySource[key].rows)
  ).join('\n\n');
}

// ---------------------------------------------------------------------------
// MEMÓRIA / APRENDIZADO (FEEDBACK LOOP)
// ---------------------------------------------------------------------------

function getMemorySheet_() {
  const memoryId = getScriptProp_('MEMORY_SHEET_ID', '');
  if (!memoryId) throw new Error('MEMORY_SHEET_ID não configurado nas Script Properties.');

  const ss = SpreadsheetApp.openById(memoryId);
  let sheet = ss.getSheetByName(MEMORY_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MEMORY_SHEET_NAME);
    sheet.appendRow(['timestamp', 'usuario', 'pergunta_original', 'resposta_incorreta', 'instrucao_correta']);
  }
  return sheet;
}

/**
 * Registra uma correção enviada pelo usuário no chat.
 */
function saveCorrection(question, wrongAnswer, correctInstruction) {
  const sheet = getMemorySheet_();
  const user = Session.getActiveUser().getEmail() || 'desconhecido';
  sheet.appendRow([new Date(), user, question, wrongAnswer, correctInstruction]);
  return { ok: true };
}

/**
 * Recupera todas as correções salvas para injeção como few-shot no prompt.
 */
function getMemoryCorrections_() {
  const sheet = getMemorySheet_();
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length <= 1) return [];

  return values.slice(1).map(row => ({
    pergunta: row[2],
    respostaErrada: row[3],
    instrucaoCorreta: row[4],
  })).filter(c => c.instrucaoCorreta);
}

function buildMemoryPromptBlock_() {
  const corrections = getMemoryCorrections_();
  if (!corrections.length) return '';

  const lines = corrections.map(c =>
    `- Pergunta semelhante: "${c.pergunta}" | Resposta que estava ERRADA: "${c.respostaErrada}" | Correção que deve ser seguida a partir de agora: "${c.instrucaoCorreta}"`
  );

  return `\n\nCORREÇÕES APRENDIDAS ANTERIORMENTE (siga-as sempre que se aplicarem, mesmo que os dados brutos pareçam sugerir outra coisa):\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// CHAMADA AO LLM
// ---------------------------------------------------------------------------

function callLLM_(systemPrompt, userMessage, options) {
  const opts = options || {};
  const provider = getScriptProp_('LLM_PROVIDER', 'anthropic');
  const apiKey = getScriptProp_('LLM_API_KEY', '');
  if (!apiKey) throw new Error('LLM_API_KEY não configurado nas Script Properties.');

  if (provider === 'anthropic') {
    const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      payload: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: opts.maxTokens || 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      muteHttpExceptions: true,
    });

    const json = JSON.parse(response.getContentText());
    if (json.error) throw new Error(json.error.message);
    return json.content && json.content[0] ? json.content[0].text : '(sem resposta)';
  }

  throw new Error(`Provedor de LLM "${provider}" não implementado neste exemplo.`);
}

// ---------------------------------------------------------------------------
// ORQUESTRAÇÃO PRINCIPAL (chamado pelo frontend via google.script.run)
// ---------------------------------------------------------------------------

/**
 * Ponto de entrada principal do chat. Fluxo de 2 passos:
 *   1. Roteia a pergunta contra o catálogo leve (metadados de 100+ fontes)
 *      e decide quais 1-2 planilhas realmente precisam ser abertas.
 *   2. Lê somente essas planilhas (linhas/abas estritamente necessárias) e
 *      monta o contexto final para responder.
 * Isso evita timeout do limite de 6 minutos do Apps Script e não estoura a
 * janela de contexto do LLM, mesmo com um catálogo grande.
 */
function processUserMessage(userMessage) {
  const catalog = loadCatalog_();

  const chosenKeys = routeToSources_(userMessage, catalog);
  if (!chosenKeys.length) {
    return {
      question: userMessage,
      answer: 'Não encontrei, no catálogo de planilhas cadastradas, uma fonte relacionada a essa pergunta. Reformule ou verifique se a planilha correta está cadastrada no catálogo.',
    };
  }

  const targetedContext = buildTargetedContext_(chosenKeys, catalog);
  const memoryBlock = buildMemoryPromptBlock_();

  const systemPrompt =
    'Você é o assistente de dados internos da Kavak. Responda em português, ' +
    'de forma objetiva, usando SOMENTE os dados fornecidos abaixo. Quando apresentar ' +
    'listas comparativas, use tabelas em Markdown. Se não encontrar o dado, diga que ' +
    'não encontrou ao invés de inventar.\n\n' +
    `DADOS DAS PLANILHAS SELECIONADAS (${chosenKeys.join(', ')}):\n` + targetedContext +
    memoryBlock;

  const answer = callLLM_(systemPrompt, userMessage);

  return {
    question: userMessage,
    answer: answer,
    fontesConsultadas: chosenKeys,
  };
}

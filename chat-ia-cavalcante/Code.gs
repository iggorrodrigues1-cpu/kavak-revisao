/**
 * ============================================================================
 * CHAT IA CENTRALIZADA - CAVALCANTE
 * Web App em Google Apps Script que cruza dados de múltiplas planilhas do
 * Google Drive corporativo e responde perguntas de negócio via LLM, com
 * memória de correções (few-shot learning dinâmico).
 * ============================================================================
 *
 * INSTALAÇÃO RÁPIDA
 * 1. Abra script.google.com > Novo projeto (ou vincule a uma planilha).
 * 2. Cole este arquivo como Code.gs e o Index.html como Index.html.
 * 3. Configure as Script Properties (Extensões > Propriedades do projeto):
 *      - LLM_API_KEY   -> chave da API do provedor de LLM usado
 *      - LLM_PROVIDER  -> "anthropic" | "openai" | "gemini" (default: anthropic)
 *      - MEMORY_SHEET_ID -> ID da planilha-mestre de Memória/Aprendizado
 * 4. Preencha o mapa SOURCE_SHEETS abaixo com as planilhas de negócio.
 * 5. Implantar > Nova implantação > Web App > Executar como "Eu" /
 *    Quem pode acessar "Qualquer pessoa na organização Kavak".
 */

// ---------------------------------------------------------------------------
// CONFIGURAÇÃO
// ---------------------------------------------------------------------------

/**
 * Cadastro das planilhas de negócio que o chat pode consultar.
 * key   -> apelido usado pelo LLM e pelos usuários para se referir à fonte
 * id    -> ID da planilha (parte da URL entre /d/ e /edit)
 * sheet -> nome da aba a ser lida (opcional; default é a primeira aba)
 */
const SOURCE_SHEETS = {
  vendas: { id: 'COLOQUE_O_ID_DA_PLANILHA_DE_VENDAS', sheet: 'Vendas' },
  estoque: { id: 'COLOQUE_O_ID_DA_PLANILHA_DE_ESTOQUE', sheet: 'Estoque' },
  // Adicione as demais 10-15 planilhas aqui seguindo o mesmo padrão.
};

const MAX_ROWS_PER_SHEET = 500; // proteção contra prompts gigantes
const MEMORY_SHEET_NAME = 'Memoria';

function getScriptProp_(key, fallback) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  return value || fallback;
}

// ---------------------------------------------------------------------------
// WEB APP ENTRY POINT
// ---------------------------------------------------------------------------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Chat IA Cavalcante')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------------------------------------------------------------------------
// LEITURA E CRUZAMENTO DE PLANILHAS
// ---------------------------------------------------------------------------

/**
 * Lê uma planilha cadastrada e devolve os dados como array de objetos
 * (primeira linha = cabeçalho), limitado a MAX_ROWS_PER_SHEET linhas.
 */
function readSheetData_(sourceKey) {
  const source = SOURCE_SHEETS[sourceKey];
  if (!source || !source.id) return null;

  const ss = SpreadsheetApp.openById(source.id);
  const sheet = source.sheet ? ss.getSheetByName(source.sheet) : ss.getSheets()[0];
  if (!sheet) return null;

  const values = sheet.getDataRange().getValues();
  if (values.length === 0) return [];

  const headers = values[0].map(h => String(h).trim());
  const rows = values.slice(1, 1 + MAX_ROWS_PER_SHEET);

  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

/**
 * Cruza duas listas de objetos por uma chave comum (ex: "placa", "id_cliente").
 * Faz um LEFT JOIN de leftRows com rightRows.
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
 * Monta um snapshot textual (compacto) de todas as planilhas cadastradas,
 * para ser injetado como contexto no prompt do LLM.
 * Em produção, para bases grandes, troque por busca seletiva (RAG real)
 * ao invés de enviar tudo.
 */
function buildSheetsContext_(sourceKeys) {
  const keys = sourceKeys && sourceKeys.length ? sourceKeys : Object.keys(SOURCE_SHEETS);
  const parts = [];

  keys.forEach(key => {
    const data = readSheetData_(key);
    if (!data) return;
    parts.push(`### Fonte: ${key}\n` + JSON.stringify(data));
  });

  return parts.join('\n\n');
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
  const values = sheet.getDataRange().getValues();
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

function callLLM_(systemPrompt, userMessage) {
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
        max_tokens: 1500,
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
 * Ponto de entrada principal do chat. Recebe a pergunta do usuário,
 * monta o contexto (dados das planilhas + memória de correções) e
 * retorna a resposta do LLM.
 */
function processUserMessage(userMessage) {
  const sheetsContext = buildSheetsContext_();
  const memoryBlock = buildMemoryPromptBlock_();

  const systemPrompt =
    'Você é um assistente de dados internos da Cavalcante. Responda em português, ' +
    'de forma objetiva, usando SOMENTE os dados fornecidos abaixo. Quando apresentar ' +
    'listas comparativas, use tabelas em Markdown. Se não encontrar o dado, diga que ' +
    'não encontrou ao invés de inventar.\n\n' +
    'DADOS DAS PLANILHAS:\n' + sheetsContext +
    memoryBlock;

  const answer = callLLM_(systemPrompt, userMessage);

  return {
    question: userMessage,
    answer: answer,
  };
}

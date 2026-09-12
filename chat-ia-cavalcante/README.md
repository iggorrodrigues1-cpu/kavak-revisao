# Chat IA Cavalcante — Web App em Google Apps Script

Chat interno que centraliza consultas às planilhas do Google Drive corporativo,
cruza dados entre elas e aprende com correções dos usuários. Roda inteiramente
dentro do Google Workspace (Apps Script + Google Sheets), sem depender de
nenhuma infraestrutura externa.

## 1. Visão geral da arquitetura

```
Usuário (navegador, domínio Kavak)
        │
        ▼
  Web App (doGet -> Index.html)
        │  google.script.run
        ▼
  Code.gs (backend Apps Script)
        │
        ├── Lê N planilhas cadastradas (SOURCE_SHEETS) via SpreadsheetApp
        │   e cruza dados por chave comum (joinByKey_)
        │
        ├── Lê a planilha "Memória e Aprendizado" (correções salvas)
        │   e injeta como few-shot no prompt do LLM
        │
        └── Chama a API do LLM (Anthropic/Claude) com o contexto montado
                │
                ▼
        Resposta exibida no chat (com suporte a tabelas Markdown)
                │
                ▼
  Usuário identifica erro -> clica "Corrigir essa resposta"
                │
                ▼
  saveCorrection() grava na planilha de Memória
  (pergunta original, resposta errada, instrução correta)
                │
                ▼
  Próxima pergunta semelhante já vem com a correção aplicada
```

Não há servidor externo: tudo roda na conta Google Workspace da Kavak,
usando as permissões nativas do domínio (compartilhamento de planilhas,
autenticação do Apps Script).

## 2. Estrutura das planilhas

### Planilhas de negócio (fonte de dados)
Cadastre cada planilha em `SOURCE_SHEETS` no `Code.gs`:

```js
const SOURCE_SHEETS = {
  vendas: { id: '1AbC...xyz', sheet: 'Vendas' },
  estoque: { id: '1DeF...uvw', sheet: 'Estoque' },
};
```

- `id`: ID da planilha (trecho da URL entre `/d/` e `/edit`).
- `sheet`: nome da aba a ler (opcional).

Cruzamentos entre planilhas usam `joinByKey_(listaA, listaB, "chave")`,
por exemplo cruzar `vendas` e `estoque` pela coluna `placa` ou `sku`.

### Planilha-mestre de Memória e Aprendizado
Crie (ou aponte) uma planilha exclusiva para armazenar correções. O script
cria automaticamente a aba `Memoria` com as colunas:

| timestamp | usuario | pergunta_original | resposta_incorreta | instrucao_correta |
|---|---|---|---|---|

Configure o ID dela na propriedade `MEMORY_SHEET_ID`.

## 3. Código

- [`Code.gs`](./Code.gs) — backend completo (leitura/cruzamento de planilhas,
  memória de correções, chamada ao LLM, orquestração).
- [`Index.html`](./Index.html) — frontend do chat (interface, tabelas em
  Markdown, fluxo de feedback/correção).

## 4. Passo a passo de implantação (domínio Kavak / Cavalcante)

1. Acesse [script.google.com](https://script.google.com) com a conta
   corporativa e crie um novo projeto (ou `Extensões > Apps Script` a partir
   de uma planilha existente).
2. Crie os arquivos `Code.gs` e `Index.html` com o conteúdo desta pasta.
3. Em **Configurações do projeto > Propriedades do script**, adicione:
   - `LLM_API_KEY`: chave de API do provedor de LLM.
   - `LLM_PROVIDER`: `anthropic` (ou implemente outro provedor em `callLLM_`).
   - `MEMORY_SHEET_ID`: ID da planilha-mestre de memória.
4. Edite `SOURCE_SHEETS` com os IDs das 10–15 planilhas de negócio.
5. Garanta que a conta que vai **executar** o Web App tenha acesso de leitura
   a todas as planilhas cadastradas (compartilhamento interno no domínio).
6. Clique em **Implantar > Nova implantação**:
   - Tipo: **Web App**.
   - Executar como: **Eu** (para usar suas permissões de leitura nas planilhas).
   - Quem pode acessar: **Qualquer pessoa na organização** (restrito ao domínio
     corporativo).
7. Copie a URL gerada e distribua internamente (ex: fixar no Slack/Drive).
8. Teste uma pergunta simples, valide o cruzamento de dados e o fluxo de
   correção antes de divulgar amplamente.

## 5. Limitações e próximos passos

- O contexto atual envia os dados das planilhas inteiros para o LLM
  (limitado por `MAX_ROWS_PER_SHEET`). Para bases grandes, evolua para uma
  busca seletiva (por palavra-chave ou embeddings) antes de montar o prompt.
- A API key fica em Script Properties (não versionada, não exposta ao
  frontend) — nunca coloque a chave diretamente no código.
- O mecanismo de memória é literal (few-shot): funciona bem para poucas
  dezenas/centenas de correções; para volume maior, considere resumir ou
  agrupar correções por tema antes de injetar no prompt.

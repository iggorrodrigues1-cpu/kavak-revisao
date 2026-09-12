# Chat IA Kavak — Web App em Google Apps Script

Chat interno que centraliza consultas a **100+ planilhas** do Google Drive
corporativo da Kavak, roteando cada pergunta para apenas as fontes relevantes
(arquitetura RAG de 2 passos), cruzando dados entre elas e aprendendo com
correções dos usuários. Roda inteiramente dentro do Google Workspace
(Apps Script + Google Sheets), sem depender de nenhuma infraestrutura externa.

A interface (`Index.html`) segue o **Kavak Brand Playbook 2025**: header em Kavak
Blue (`#0467FC`) com logo branco, fundo padrão branco, bolhas de conversa em Kavak
Blue (usuário) e card fill claro `#EBF1FF` (IA), tipografia Kavak Telegraf nos
títulos e Helvetica Neue no corpo, e footer com logo azul + "Interno · Kavak".
Logos e fontes estão embutidos em base64 diretamente no HTML (não há hospedagem
externa de assets, compatível com o Apps Script HtmlService).

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
        ├── PASSO 1 — ROTEAMENTO (leve, rápido)
        │   Lê o catálogo de metadados (planilha "Catalogo": até 100+ linhas,
        │   uma por fonte) e pergunta ao LLM apenas "qual(is) fonte(s) tem o
        │   dado?" — nunca envia os dados em si nesse passo.
        │
        ├── PASSO 2 — LEITURA DIRECIONADA
        │   Abre SOMENTE as 1-2 planilhas escolhidas no Passo 1, lendo
        │   apenas a aba e o intervalo de linhas necessários
        │   (getDisplayValues() limitado por MAX_ROWS_PER_SHEET), e cruza
        │   os dados por chave comum quando aplicável.
        │
        ├── Lê a planilha "Memória e Aprendizado" (correções salvas)
        │   e injeta como few-shot no prompt final do LLM
        │
        └── Chama a API do LLM (Anthropic/Claude) com o contexto reduzido
                │
                ▼
        Resposta exibida no chat (tabelas Markdown + fontes consultadas)
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

### Por que 2 passos em vez de ler tudo de uma vez?
Com 100+ planilhas cadastradas, ler todas a cada pergunta:
- estoura a janela de contexto do LLM;
- corre risco de ultrapassar o limite de 6 minutos de execução do Apps Script;
- é lento e caro sem necessidade, já que a maioria das perguntas só precisa
  de 1 ou 2 fontes.

O roteamento resolve isso: o Passo 1 nunca toca nos dados brutos, apenas nos
metadados leves (descrição + colunas principais de cada fonte), então é
praticamente instantâneo mesmo com um catálogo grande. Só o Passo 2 abre
planilhas de verdade — e apenas as escolhidas.

## 2. Estrutura das planilhas

### 2.1 Planilha de Catálogo (metadados — substitui o cadastro no código)
Para suportar 100+ fontes sem precisar editar `Code.gs` toda vez, o catálogo
vive em uma planilha própria, configurada via `CATALOG_SHEET_ID`. Crie uma
aba chamada `Catalogo` com as colunas:

| chave | spreadsheet_id | aba | descricao | colunas_principais | chave_cruzamento |
|---|---|---|---|---|---|
| vendas_sp | 1AbC...xyz | Vendas | Vendas de veículos por loja em SP, com preço, modelo e data | placa, modelo, preco, data_venda | placa |
| estoque | 1DeF...uvw | Estoque | Estoque atual de veículos disponíveis por loja | placa, modelo, loja, dias_em_estoque | placa |
| ... (mais 100 linhas) | | | | | |

- `chave`: apelido curto e único (usado internamente pelo roteador).
- `spreadsheet_id`: ID da planilha de negócio (trecho da URL entre `/d/` e `/edit`).
- `aba`: nome da aba a ler.
- `descricao`: frase clara do que a planilha contém — **quanto melhor a
  descrição, melhor o roteamento do LLM**.
- `colunas_principais`: lista de colunas relevantes, separada por vírgula.
- `chave_cruzamento`: coluna usada para cruzar com outra fonte (opcional).

O catálogo é cacheado por 6h (`CacheService`) para não reler a planilha de
metadados a cada pergunta.

### 2.2 Planilha-mestre de Memória e Aprendizado
Configurada via `MEMORY_SHEET_ID`. O script cria automaticamente a aba
`Memoria` com as colunas:

| timestamp | usuario | pergunta_original | resposta_incorreta | instrucao_correta |
|---|---|---|---|---|

## 3. Código

- [`Code.gs`](./Code.gs) — backend completo: catálogo de metadados, roteamento
  em 2 passos, leitura direcionada com `getDisplayValues()`, cruzamento por
  chave, memória de correções e chamada ao LLM.
- [`Index.html`](./Index.html) — frontend do chat (interface Kavak, tabelas em
  Markdown, exibição das fontes consultadas, fluxo de feedback/correção).

## 4. Passo a passo de implantação (domínio Kavak)

1. Acesse [script.google.com](https://script.google.com) com a conta
   corporativa e crie um novo projeto (ou `Extensões > Apps Script` a partir
   de uma planilha existente).
2. Crie os arquivos `Code.gs` e `Index.html` com o conteúdo desta pasta.
3. Crie a **planilha de Catálogo** (aba `Catalogo`, conforme seção 2.1) e
   cadastre as 100+ fontes de dados da Kavak.
4. Crie (ou aponte) a **planilha de Memória**.
5. Em **Configurações do projeto > Propriedades do script**, adicione:
   - `LLM_API_KEY`: chave de API do provedor de LLM.
   - `LLM_PROVIDER`: `anthropic` (ou implemente outro provedor em `callLLM_`).
   - `CATALOG_SHEET_ID`: ID da planilha de catálogo.
   - `MEMORY_SHEET_ID`: ID da planilha-mestre de memória.
6. Garanta que a conta que vai **executar** o Web App tenha acesso de leitura
   a todas as planilhas cadastradas no catálogo (compartilhamento interno no
   domínio).
7. Clique em **Implantar > Nova implantação**:
   - Tipo: **Web App**.
   - Executar como: **Eu** (para usar suas permissões de leitura nas planilhas).
   - Quem pode acessar: **Qualquer pessoa na organização** (restrito ao domínio
     corporativo).
8. Copie a URL gerada e distribua internamente.
9. Teste perguntas envolvendo diferentes fontes do catálogo, valide o
   cruzamento de dados e o fluxo de correção antes de divulgar amplamente.

## 5. Limitações e próximos passos

- O roteamento (Passo 1) depende da qualidade das descrições no catálogo —
  descrições vagas levam a escolhas de fonte erradas. Revise periodicamente.
- `MAX_SOURCES_PER_QUERY` limita a 2 fontes por pergunta; perguntas que
  exigem cruzar 3+ planilhas precisam ser divididas ou o limite ajustado
  (atenção ao tamanho do contexto do LLM).
- Para catálogos muito grandes (centenas de linhas), considere paginar o
  Passo 1 ou usar embeddings/busca vetorial no lugar do LLM para rotear,
  reduzindo custo e latência.
- A API key fica em Script Properties (não versionada, não exposta ao
  frontend) — nunca coloque a chave diretamente no código.
- O mecanismo de memória é literal (few-shot): funciona bem para poucas
  dezenas/centenas de correções; para volume maior, considere resumir ou
  agrupar correções por tema antes de injetar no prompt.

# StorkOracleSyncEngine

## Visão Geral

StorkOracleSyncEngine é uma ferramenta modular de orquestração de sessões desenvolvida para interagir com a infraestrutura descentralizada de oráculos do ecossistema DEPIN, com foco específico na rede Stork Oracle. A ferramenta permite interações autenticadas com múltiplas identidades, realizando validações periódicas de dados em escala, com suporte a autenticação via Cognito, rotação de proxies e execução paralela com threads.

---

## Funcionalidades

- **Orquestração de Sessões Paralelas**: Gerencia autenticação e renovação de sessões independentes com suporte a tokens temporários usando Amazon Cognito.
- **Interação Segura com API**: Automatiza tarefas de validação na API da Stork Oracle com cabeçalhos e origens configuráveis.
- **Suporte a Proxies**: Roteia requisições por proxies dedicados ou uma lista global para simulação de tráfego distribuído.
- **Execução Paralela**: Utiliza `worker threads` para validar dados de preços assinados em paralelo entre as contas ativas.
- **Persistência Local de Tokens**: Armazena e atualiza os tokens por usuário para evitar múltiplas autenticações repetitivas.
- **Log Robusto**: Exibe logs com timestamp para auditoria e depuração.

---

##  Estrutura dos Arquivos

- `index.js`: Script principal de execução. Responsável por autenticação, tokens, coleta de dados e validação.
- `config.json`: Arquivo de configuração com credenciais, proxies e parâmetros por conta.
- `tokens_*.json`: Arquivos individuais de token para cada identidade, contendo `accessToken`, `refreshToken` e estado da sessão.
- `package.json`: Metadados do projeto e dependências.
- `node_modules/`: Pasta gerada automaticamente contendo bibliotecas do projeto (via `npm install`).

---

## Como Começar

### Pré-requisitos

- Node.js (versão >=14)
- npm

### Instalação

1. Clone o repositório:
   ```bash
   git clone https://github.com/seuusuario/StorkOracleSyncEngine.git
   cd StorkOracleSyncEngine
   ```

2. Instale as dependências:
   ```bash
   npm install
   ```

3. Edite o arquivo `config.json` com suas credenciais, proxies e configurações desejadas.

4. Execute a ferramenta:
   ```bash
   npm start
   ```

---

## Gerenciamento de Tokens

Cada identidade listada no `config.json` terá um arquivo `tokens_<username>.json` correspondente, criado ou atualizado com os tokens válidos da sessão. A renovação é feita automaticamente via Cognito ou pela própria API da Stork.

---

##  Sobre a Stork Oracle

[Stork Oracle](https://stork-oracle.network) é um protocolo descentralizado de oráculos que valida dados de preços assinados como parte de uma infraestrutura DEPIN. Esta ferramenta oferece uma interface programável para participar dessas validações de forma estruturada, segura e automatizada.

---



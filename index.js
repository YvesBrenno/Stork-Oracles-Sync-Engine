const AmazonCognitoIdentity = require('amazon-cognito-identity-js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

global.navigator = { userAgent: 'node' };

function getFormattedDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substr(0, 19);
}

function log(message, type = 'INFO') {
  console.log(`[${getFormattedDate()}] [${type}] ${message}`);
}

// Função para realizar retry com backoff exponencial
function retryOperation(operation, maxAttempts, initialDelay) {
  return new Promise((resolve, reject) => {
    function attempt(remainingAttempts) {
      operation()
        .then(resolve)
        .catch(err => {
          // Verifica se o erro é por excesso de requisições
          if (remainingAttempts === 1 || err.code !== 'TooManyRequestsException') {
            reject(err);
          } else {
            const delay = initialDelay * Math.pow(2, maxAttempts - remainingAttempts);
            log(`TooManyRequestsException detectado. Tentando novamente em ${delay} ms. Tentativas restantes: ${remainingAttempts - 1}`, 'WARN');
            setTimeout(() => attempt(remainingAttempts - 1), delay);
          }
        });
    }
    attempt(maxAttempts);
  });
}

// ================================================================
// Configuração: Lê o arquivo config.json e cria um padrão se não existir
// ================================================================
function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config.json');
    if (!fs.existsSync(configPath)) {
      log(`Arquivo de configuração não encontrado em ${configPath}. Criando configuração padrão.`, 'WARN');
      const defaultConfig = {
        accounts: [
          {
            cognito: {
              region: 'ap-northeast-1',
              clientId: '5msns4n49hmg3dftp2tp1t2iuh',
              userPoolId: 'ap-northeast-1_M22I44OpC',
              username: "",      // Preencha com o e-mail da conta
              password: ""       // Preencha com a senha da conta
            },
            stork: {
              baseURL: 'https://app-api.jp.stork-oracle.network/v1',
              authURL: 'https://api.jp.stork-oracle.network/auth',
              tokenPath: path.join(__dirname, 'tokens_USER.json'),
              intervalSeconds: 10,
              userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
              origin: 'chrome-extension://knnliglhgkmlblppdejchidfihjnockl'
            },
            proxy: null // Se desejar, defina aqui o proxy para essa conta (ex: "http://meuproxy:porta")
          }
        ],
        threads: {
          maxWorkers: 10,
          proxyFile: path.join(__dirname, 'proxies.txt')
        }
      };
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
      return defaultConfig;
    }
    const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    log('Configuração carregada com sucesso a partir do config.json');
    return userConfig;
  } catch (error) {
    log(`Erro ao carregar configuração: ${error.message}`, 'ERROR');
    throw new Error('Falha ao carregar configuração');
  }
}

const userConfig = loadConfig();
const globalConfig = {
  threads: {
    maxWorkers: userConfig.threads?.maxWorkers || 10,
    proxyFile: userConfig.threads?.proxyFile || path.join(__dirname, 'proxies.txt')
  }
};
const accounts = userConfig.accounts || [];

// Verifica se as credenciais estão definidas para cada conta
function validateAccountConfig(account) {
  if (!account.cognito.username || !account.cognito.password) {
    log(`ERROR: Credenciais ausentes para a conta. Atualize o config.json com username e password.`, 'ERROR');
    return false;
  }
  return true;
}

// ================================================================
// Função para carregar proxies globais (caso nenhuma conta defina proxy)
// ================================================================
function loadProxies() {
  try {
    if (!fs.existsSync(globalConfig.threads.proxyFile)) {
      log(`Arquivo de proxy não encontrado em ${globalConfig.threads.proxyFile}, criando arquivo vazio.`, 'WARN');
      fs.writeFileSync(globalConfig.threads.proxyFile, '', 'utf8');
      return [];
    }
    const proxyData = fs.readFileSync(globalConfig.threads.proxyFile, 'utf8');
    const proxies = proxyData.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    log(`Carregados ${proxies.length} proxies do arquivo ${globalConfig.threads.proxyFile}`);
    return proxies;
  } catch (error) {
    log(`Erro ao carregar proxies: ${error.message}`, 'ERROR');
    return [];
  }
}

function getProxyAgent(proxy) {
  if (!proxy) return null;
  if (proxy.startsWith('http')) return new HttpsProxyAgent(proxy);
  if (proxy.startsWith('socks4') || proxy.startsWith('socks5')) return new SocksProxyAgent(proxy);
  throw new Error(`Protocolo de proxy não suportado: ${proxy}`);
}

// ================================================================
// Classes para autenticação e gerenciamento de tokens (por conta)
// ================================================================
class CognitoAuth {
  constructor(username, password, region, clientId, userPoolId) {
    this.username = username;
    this.password = password;
    this.authenticationDetails = new AmazonCognitoIdentity.AuthenticationDetails({ Username: username, Password: password });
    const poolData = { UserPoolId: userPoolId, ClientId: clientId };
    const userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);
    this.cognitoUser = new AmazonCognitoIdentity.CognitoUser({ Username: username, Pool: userPool });
  }

  authenticate() {
    return new Promise((resolve, reject) => {
      this.cognitoUser.authenticateUser(this.authenticationDetails, {
        onSuccess: (result) => resolve({
          accessToken: result.getAccessToken().getJwtToken(),
          idToken: result.getIdToken().getJwtToken(),
          refreshToken: result.getRefreshToken().getToken(),
          expiresIn: result.getAccessToken().getExpiration() * 1000 - Date.now()
        }),
        onFailure: (err) => reject(err),
        newPasswordRequired: () => reject(new Error('Nova senha requerida'))
      });
    });
  }

  refreshSession(refreshToken) {
    const refreshTokenObj = new AmazonCognitoIdentity.CognitoRefreshToken({ RefreshToken: refreshToken });
    return new Promise((resolve, reject) => {
      this.cognitoUser.refreshSession(refreshTokenObj, (err, result) => {
        if (err) reject(err);
        else resolve({
          accessToken: result.getAccessToken().getJwtToken(),
          idToken: result.getIdToken().getJwtToken(),
          refreshToken: refreshToken,
          expiresIn: result.getAccessToken().getExpiration() * 1000 - Date.now()
        });
      });
    });
  }

  // Aumentamos o número de tentativas e o atraso para evitar rate limits
  authenticateWithRetry(retryCount = 10, initialDelay = 2000) {
    return retryOperation(() => this.authenticate(), retryCount, initialDelay);
  }

  // Aumentamos o número de tentativas e o atraso para evitar rate limits
  refreshSessionWithRetry(refreshToken, retryCount = 10, initialDelay = 2000) {
    return retryOperation(() => this.refreshSession(refreshToken), retryCount, initialDelay);
  }
}

class TokenManager {
  constructor(account) {
    this.account = account;
    this.accessToken = null;
    this.refreshToken = null;
    this.idToken = null;
    this.expiresAt = null;
    this.auth = new CognitoAuth(
      account.cognito.username,
      account.cognito.password,
      account.cognito.region,
      account.cognito.clientId,
      account.cognito.userPoolId
    );
  }

  async getValidToken() {
    if (!this.accessToken || this.isTokenExpired()) await this.refreshOrAuthenticate();
    return this.accessToken;
  }

  isTokenExpired() {
    return Date.now() >= this.expiresAt;
  }

  async refreshOrAuthenticate() {
    try {
      let result = this.refreshToken
        ? await this.auth.refreshSessionWithRetry(this.refreshToken)
        : await this.auth.authenticateWithRetry();
      await this.updateTokens(result);
    } catch (error) {
      // Capturamos o erro para evitar que o sistema pare abruptamente
      log(`Erro ao atualizar token para ${this.account.cognito.username}: ${error.message}`, 'ERROR');
      // Se necessário, podemos optar por tentar novamente em um momento posterior
      // (por exemplo, com um setTimeout) ao invés de propagar o erro
      throw error;
    }
  }

  async updateTokens(result) {
    this.accessToken = result.accessToken;
    this.idToken = result.idToken;
    this.refreshToken = result.refreshToken;
    this.expiresAt = Date.now() + result.expiresIn;
    const tokens = {
      accessToken: this.accessToken,
      idToken: this.idToken,
      refreshToken: this.refreshToken,
      isAuthenticated: true,
      isVerifying: false
    };
    await saveTokens(tokens, this.account.stork.tokenPath);
    log(`Tokens atualizados e salvos para ${this.account.cognito.username}`);
  }
}

async function getTokens(tokenPath) {
  try {
    if (!fs.existsSync(tokenPath)) throw new Error(`Arquivo de tokens não encontrado em ${tokenPath}`);
    const tokensData = await fs.promises.readFile(tokenPath, 'utf8');
    const tokens = JSON.parse(tokensData);
    if (!tokens.accessToken || tokens.accessToken.length < 20) throw new Error('Token de acesso inválido');
    log(`Token lido com sucesso: ${tokens.accessToken.substring(0, 10)}...`);
    return tokens;
  } catch (error) {
    log(`Erro ao ler tokens: ${error.message}`, 'ERROR');
    throw error;
  }
}

async function saveTokens(tokens, tokenPath) {
  try {
    await fs.promises.writeFile(tokenPath, JSON.stringify(tokens, null, 2), 'utf8');
    log('Tokens salvos com sucesso');
    return true;
  } catch (error) {
    log(`Erro ao salvar tokens: ${error.message}`, 'ERROR');
    return false;
  }
}

async function refreshTokens(refreshToken, accountConfig) {
  try {
    log(`Atualizando token via API Stork para ${accountConfig.cognito.username}...`);

    const response = await axios({
      method: 'POST',
      url: `${accountConfig.stork.authURL}/refresh`,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': accountConfig.stork.userAgent,
        'Origin': accountConfig.stork.origin
      },
      data: { refresh_token: refreshToken }
    });
    const tokens = {
      accessToken: response.data.access_token,
      idToken: response.data.id_token || '',
      refreshToken: response.data.refresh_token || refreshToken,
      isAuthenticated: true,
      isVerifying: false
    };
    await saveTokens(tokens, accountConfig.stork.tokenPath);
    log(`Token atualizado com sucesso via API Stork para ${accountConfig.cognito.username}`);
    return tokens;
  } catch (error) {
    log(`Falha na atualização do token: ${error.message}`, 'ERROR');
    throw error;
  }
}

// ================================================================
// Funções para consumir a API Stork (por conta)
// ================================================================
async function getSignedPrices(tokens, accountConfig) {
  try {
    log(`Buscando dados de preços assinados para ${accountConfig.cognito.username}...`);
    const response = await axios({
      method: 'GET',
      url: `${accountConfig.stork.baseURL}/stork_signed_prices`,
      headers: {
        'Authorization': `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
        'Origin': accountConfig.stork.origin,
        'User-Agent': accountConfig.stork.userAgent
      }
    });
    const dataObj = response.data.data;
    const result = Object.keys(dataObj).map(assetKey => {
      const assetData = dataObj[assetKey];
      return {
        asset: assetKey,
        msg_hash: assetData.timestamped_signature.msg_hash,
        price: assetData.price,
        timestamp: new Date(assetData.timestamped_signature.timestamp / 1000000).toISOString(),
        ...assetData
      };
    });
    log(`Foram recuperados ${result.length} preços assinados para ${accountConfig.cognito.username}`);
    return result;
  } catch (error) {
    log(`Erro ao buscar preços assinados: ${error.message}`, 'ERROR');
    throw error;
  }
}

async function sendValidation(tokens, msgHash, isValid, proxy, accountConfig) {
  try {
    const agent = getProxyAgent(proxy);
    const response = await axios({
      method: 'POST',
      url: `${accountConfig.stork.baseURL}/stork_signed_prices/validations`,
      headers: {
        'Authorization': `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
        'Origin': accountConfig.stork.origin,
        'User-Agent': accountConfig.stork.userAgent
      },
      httpsAgent: agent,
      data: { msg_hash: msgHash, valid: isValid }
    });
    log(`✓ Validação bem-sucedida para ${msgHash.substring(0, 10)}... via ${proxy || 'direto'} para ${accountConfig.cognito.username}`);
    return response.data;
  } catch (error) {
    log(`✗ Falha na validação para ${msgHash.substring(0, 10)}...: ${error.message}`, 'ERROR');
    throw error;
  }
}

async function getUserStats(tokens, accountConfig) {
  try {
    log(`Buscando estatísticas do usuário para ${accountConfig.cognito.username}...`);
    const response = await axios({
      method: 'GET',
      url: `${accountConfig.stork.baseURL}/me`,
      headers: {
        'Authorization': `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
        'Origin': accountConfig.stork.origin,
        'User-Agent': accountConfig.stork.userAgent
      }
    });
    return response.data.data;
  } catch (error) {
    log(`Erro ao buscar estatísticas do usuário: ${error.message}`, 'ERROR');
    throw error;
  }
}

function validatePrice(priceData) {
  try {
    log(`Validando dados para ${priceData.asset || 'ativo desconhecido'}`);
    if (!priceData.msg_hash || !priceData.price || !priceData.timestamp) {
      log('Dados incompletos, considerados inválidos', 'WARN');
      return false;
    }
    const currentTime = Date.now();
    const dataTime = new Date(priceData.timestamp).getTime();
    const timeDiffMinutes = (currentTime - dataTime) / (1000 * 60);
    if (timeDiffMinutes > 60) {
      log(`Dados muito antigos (${Math.round(timeDiffMinutes)} minutos atrás)`, 'WARN');
      return false;
    }
    return true;
  } catch (error) {
    log(`Erro na validação: ${error.message}`, 'ERROR');
    return false;
  }
}

// ================================================================
// Worker: executa a validação de cada item
// ================================================================
if (!isMainThread) {
  const { priceData, tokens, proxy, accountConfig } = workerData;
  async function validateAndSend() {
    try {
      const isValid = validatePrice(priceData);
      await sendValidation(tokens, priceData.msg_hash, isValid, proxy, accountConfig);
      parentPort.postMessage({ success: true, msgHash: priceData.msg_hash, isValid });
    } catch (error) {
      parentPort.postMessage({ success: false, error: error.message, msgHash: priceData.msg_hash });
    }
  }
  validateAndSend();
} else {
  // ================================================================
  // Classe que representa uma instância de operação para cada conta
  // ================================================================
  class AccountInstance {
    constructor(account) {
      this.account = account;
      this.tokenManager = new TokenManager(account);
      // Se a conta definir um proxy, ele será usado; caso contrário, usará proxies globais
      this.proxy = account.proxy;
      this.previousStats = { validCount: 0, invalidCount: 0 };
    }

    async runValidationProcess() {
      try {
        log(`--------- INICIANDO PROCESSO DE VALIDAÇÃO para ${this.account.cognito.username} ---------`);
        const tokens = await getTokens(this.account.stork.tokenPath);
        const initialUserData = await getUserStats(tokens, this.account);

        if (!initialUserData || !initialUserData.stats) {
          throw new Error('Não foi possível buscar as estatísticas iniciais do usuário');
        }

        const initialValidCount = initialUserData.stats.stork_signed_prices_valid_count || 0;
        const initialInvalidCount = initialUserData.stats.stork_signed_prices_invalid_count || 0;
        if (this.previousStats.validCount === 0 && this.previousStats.invalidCount === 0) {
          this.previousStats.validCount = initialValidCount;
          this.previousStats.invalidCount = initialInvalidCount;
        }

        const signedPrices = await getSignedPrices(tokens, this.account);
        // Se não houver proxy definido para a conta, utiliza a lista global
        const proxies = this.proxy ? [this.proxy] : loadProxies();

        if (!signedPrices || signedPrices.length === 0) {
          log('Nenhum dado para validar');
          const userData = await getUserStats(tokens, this.account);
          this.displayStats(userData);
          return;
        }

        log(`Processando ${signedPrices.length} dados com ${globalConfig.threads.maxWorkers} workers para ${this.account.cognito.username}...`);
        const workers = [];
        const chunkSize = Math.ceil(signedPrices.length / globalConfig.threads.maxWorkers);
        const batches = [];
        for (let i = 0; i < signedPrices.length; i += chunkSize) {
          batches.push(signedPrices.slice(i, i + chunkSize));
        }

        for (let i = 0; i < Math.min(batches.length, globalConfig.threads.maxWorkers); i++) {
          const batch = batches[i];
          const proxyToUse = proxies.length > 0 ? proxies[i % proxies.length] : null;
          batch.forEach(priceData => {
            workers.push(new Promise((resolve) => {
              const worker = new Worker(__filename, {
                workerData: { priceData, tokens, proxy: proxyToUse, accountConfig: this.account }
              });
              worker.on('message', resolve);
              worker.on('error', (error) => resolve({ success: false, error: error.message }));
              worker.on('exit', () => resolve({ success: false, error: 'Worker finalizado' }));
            }));
          });
        }

        const results = await Promise.all(workers);
        const successCount = results.filter(r => r.success).length;
        log(`Processados ${successCount}/${results.length} validações com sucesso para ${this.account.cognito.username}`);

        const updatedUserData = await getUserStats(tokens, this.account);
        const newValidCount = updatedUserData.stats.stork_signed_prices_valid_count || 0;
        const newInvalidCount = updatedUserData.stats.stork_signed_prices_invalid_count || 0;
        const actualValidIncrease = newValidCount - this.previousStats.validCount;
        const actualInvalidIncrease = newInvalidCount - this.previousStats.invalidCount;
        this.previousStats.validCount = newValidCount;
        this.previousStats.invalidCount = newInvalidCount;

        this.displayStats(updatedUserData);
        log(`--------- RESUMO DA VALIDAÇÃO para ${this.account.cognito.username} ---------`);
        log(`Total de dados processados: ${actualValidIncrease + actualInvalidIncrease}`);
        log(`Sucesso: ${actualValidIncrease}`);
        log(`Falha: ${actualInvalidIncrease}`);
        log('--------- COMPLETO ---------');
      } catch (error) {
        log(`Processo de validação interrompido para ${this.account.cognito.username}: ${error.message}`, 'ERROR');
      }
    }

    displayStats(userData) {
      if (!userData || !userData.stats) {
        log('Estatísticas inválidas para exibição', 'WARN');
        return;
      }
      console.clear();
      console.log('=============================================');
      console.log('   STORK ORACLE SYNC ENGINE   ');
      console.log('=============================================');
      console.log(`Time: ${getTimestamp()}`);
      console.log('---------------------------------------------');
      console.log(`User: ${userData.email || 'N/A'}`);
      console.log(`ID: ${userData.id || 'N/A'}`);
      console.log(`Referral Code: ${userData.referral_code || 'N/A'}`);
      console.log('---------------------------------------------');
      console.log('ESTATÍSTICAS DE VALIDAÇÃO:');
      console.log(`✓ Validações Válidas: ${userData.stats.stork_signed_prices_valid_count || 0}`);
      console.log(`✗ Validações Inválidas: ${userData.stats.stork_signed_prices_invalid_count || 0}`);
      console.log(`↻ Última Validação: ${userData.stats.stork_signed_prices_last_verified_at || 'Nunca'}`);
      console.log(`👥 Uso de Referral: ${userData.stats.referral_usage_count || 0}`);
      console.log('---------------------------------------------');
      console.log(`Próxima validação em ${this.account.stork.intervalSeconds} segundos...`);
      console.log('=============================================');
    }

    async start() {
      try {
        // Aqui garantimos que o token válido seja obtido e, se der erro, a exceção será tratada
        await this.tokenManager.getValidToken();
        log(`Autenticação inicial bem-sucedida para ${this.account.cognito.username}`);
        this.runValidationProcess();
        setInterval(() => this.runValidationProcess(), this.account.stork.intervalSeconds * 1000);
        // Mantemos a atualização periódica do token. Se os erros persistirem, considere aumentar o intervalo.
        setInterval(async () => {
          try {
            await this.tokenManager.getValidToken();
            log(`Token atualizado via Cognito para ${this.account.cognito.username}`);
          } catch (error) {
            // Evita que falhas no refresh interrompam o fluxo
            log(`Erro na atualização periódica do token para ${this.account.cognito.username}: ${error.message}`, 'ERROR');
          }
        }, 50 * 60 * 1000);
      } catch (error) {
        log(`Falha ao iniciar aplicação para ${this.account.cognito.username}: ${error.message}`, 'ERROR');
      }
    }
  }

  // Função principal: itera por todas as contas configuradas e inicia cada instância

  async function main() {
    for (const account of accounts) {
      if (!validateAccountConfig(account)) {
        console.log(`Configuração inválida para a conta: ${account.cognito.username}`);
        continue;
      }
      const instance = new AccountInstance(account);
      instance.start();
    }
  }

  main();
}

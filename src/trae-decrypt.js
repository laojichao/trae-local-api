/**
 * trae-decrypt.js - Trae CN "tc" encryption format decryption
 *
 * Decrypts the encrypted auth data stored in Trae CN's storage.json.
 *
 * Data structure: [6B Header][32B RandomBytes][N EncryptedData]
 * Decrypted:      [64B SHA-512 Hash][N Plaintext JSON]
 *
 * Key derivation: SHA-512(RandomBytes) -> +XOR-Salt -> SHA-512 -> Key(16B) + IV(16B)
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 4 hardcoded salt arrays from Trae CN's frontend JS (64 bytes each)
const SALT_A = Uint8Array.from([
  82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,
  124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,
  84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,
  8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37
]);

const SALT_B = Uint8Array.from([
  31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,
  96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,
  160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,
  23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125
]);

const SALT_C = Uint8Array.from([
  191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,
  135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,
  51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,
  18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209
]);

const SALT_D = Uint8Array.from([
  246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,
  50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,
  175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,
  86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170
]);

function xorSalts(a, b, len) {
  const result = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = a[i] ^ b[i];
  }
  return result;
}

function detectEncType(header) {
  // AES type: 0x74 0x63 0x05 0x10 0x00 0x00 ("tc" prefix)
  if (header[0] === 0x74 && header[1] === 0x63 &&
      header[2] === 0x05 && header[3] === 0x10 &&
      header[4] === 0x00 && header[5] === 0x00) {
    return 'AES';
  }
  // AES_PRIVATE type: 18 57 32 32 2 3
  if (header[0] === 18 && header[1] === 57 &&
      header[2] === 32 && header[3] === 32 &&
      header[4] === 2 && header[5] === 3) {
    return 'AES_PRIVATE';
  }
  return 'UNKNOWN';
}

function deriveKeyAndIV(randomBytes, encType) {
  // 1. Select salt based on encryption type
  let salt;
  if (encType === 'AES_PRIVATE') {
    salt = xorSalts(SALT_C, SALT_D, 64);
  } else {
    salt = xorSalts(SALT_A, SALT_B, 64);
  }

  // 2. SHA-512(RandomBytes) -> hashOfRandom (64 bytes)
  const hashOfRandom = crypto.createHash('sha512')
    .update(Buffer.from(randomBytes))
    .digest();

  // 3. SHA-512(hashOfRandom + salt) -> finalHash (64 bytes)
  const combined = Buffer.concat([hashOfRandom, Buffer.from(salt)]);
  const finalHash = crypto.createHash('sha512')
    .update(combined)
    .digest();

  // 4. Split into AES Key (16B) and IV (16B)
  const aesKey = finalHash.slice(0, 16);
  const iv = finalHash.slice(16, 32);

  return { aesKey, iv };
}

function aesCbcDecrypt(key, iv, data) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  let decrypted = decipher.update(data);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted;
}

/**
 * Decrypt a single "tc" format encrypted value
 * @param {string} base64Value - Base64 encoded encrypted data
 * @returns {string} Decrypted plaintext string
 */
function decryptStorageValue(base64Value) {
  const buffer = Buffer.from(base64Value, 'base64');

  // Parse data structure: [6B Header][32B RandomBytes][N EncryptedData]
  const header = buffer.slice(0, 6);
  const randomBytes = buffer.slice(6, 38);
  const encryptedData = buffer.slice(38);

  // Detect encryption type
  const encType = detectEncType(header);
  if (encType === 'UNKNOWN') {
    throw new Error('Unknown encryption type');
  }

  // Derive AES key and IV
  const { aesKey, iv } = deriveKeyAndIV(randomBytes, encType);

  // AES-128-CBC decrypt
  const decrypted = aesCbcDecrypt(aesKey, iv, encryptedData);

  // Verify hash: [64B SHA-512 Hash][N Plaintext JSON]
  const storedHash = decrypted.slice(0, 64);
  const plaintext = decrypted.slice(64);
  const computedHash = crypto.createHash('sha512').update(plaintext).digest();

  if (!storedHash.equals(computedHash)) {
    throw new Error('Hash verification failed - decryption may be incorrect');
  }

  return plaintext.toString('utf8');
}

/**
 * Decrypt auth data from Trae CN's storage.json
 * @param {string} dataDir - Trae user data directory
 * @returns {object} Decrypted auth object { token, refreshToken, userId, ... }
 */
function decryptAuthData(dataDir) {
  const storagePath = path.join(dataDir, 'globalStorage', 'storage.json');

  if (!fs.existsSync(storagePath)) {
    throw new Error(`storage.json not found at: ${storagePath}`);
  }

  const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  const encryptedAuth = storage['iCubeAuthInfo://icube.cloudide'];

  if (!encryptedAuth) {
    throw new Error('iCubeAuthInfo://icube.cloudide key not found in storage.json');
  }

  // If it starts with '{', it's plaintext (SG version)
  if (encryptedAuth.trim().startsWith('{')) {
    console.log('[decrypt] Auth data is plaintext (SG edition)');
    return JSON.parse(encryptedAuth);
  }

  // Otherwise decrypt using tc format (CN version)
  console.log('[decrypt] Decrypting CN edition tc format...');
  const decrypted = decryptStorageValue(encryptedAuth);
  return JSON.parse(decrypted);
}

/**
 * Get OS-specific app data directory.
 */
function getAppDataDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }

  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/**
 * Get Trae CN data directory path
 */
function getTraeCNDataDir() {
  return path.join(getAppDataDir(), 'Trae CN', 'User');
}

/**
 * Get Trae SG data directory path
 */
function getTraeSGDataDir() {
  return path.join(getAppDataDir(), 'Trae', 'User');
}

module.exports = {
  decryptStorageValue,
  decryptAuthData,
  getTraeCNDataDir,
  getTraeSGDataDir,
};

const crypto = require('crypto');

const args = process.argv.slice(2);
const durationArg = args[0] || '1m';
const deviceId = args[1] || 'YOUR_DEVICE_ID_HERE';

let durationMs = 0;
let isPermanent = false;
if (durationArg === '1m') {
    durationMs = 30 * 24 * 60 * 60 * 1000;
} else if (durationArg === '6m') {
    durationMs = 180 * 24 * 60 * 60 * 1000;
} else if (durationArg === '12m') {
    durationMs = 365 * 24 * 60 * 60 * 1000;
} else if (durationArg === 'permanent') {
    isPermanent = true;
} else {
    console.error("Invalid duration. Use: 1m, 6m, 12m, permanent");
    process.exit(1);
}

// 1. RSA 키 쌍 생성
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

console.log("==========================================");
console.log("1. 아래의 PUBLIC KEY를 license.rs의 PUBLIC_KEY_PEM에 덮어쓰세요.");
console.log("==========================================\n");
console.log(publicKey);

// 2. 라이선스 내용물(Payload) 작성
const expires_at = isPermanent ? 4102444800 : Math.floor((Date.now() + durationMs) / 1000);

const payloadObj = {
  email: "test@example.com",     // 테스트용 이메일
  device_id: deviceId, 
  expires_at: expires_at 
};

const payloadStr = JSON.stringify(payloadObj);
const payloadB64 = Buffer.from(payloadStr).toString('base64');

// 3. Private Key로 서명(Signature) 생성
const sign = crypto.createSign('RSA-SHA256');
sign.update(Buffer.from(payloadStr)); 
sign.end();
const signatureB64 = sign.sign(privateKey, 'base64');

// 4. 최종 라이선스 코드
const licenseCode = `${payloadB64}.${signatureB64}`;

console.log("==========================================");
console.log(`2. 발급된 테스트 라이선스 코드 (${durationArg})`);
console.log("==========================================\n");
console.log(licenseCode);
console.log("\n테스트 이메일: test@example.com");

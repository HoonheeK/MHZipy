import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

// .env 파일 로드
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
    console.log("🚀 포스트 빌드 및 R2 업로드 프로세스 시작...");

    // 1. tauri.conf.json에서 현재 버전 읽기
    const tauriConfPath = path.resolve(__dirname, '../src-tauri/tauri.conf.json');
    const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    const version = tauriConf.version;

    // 2. 파일 경로 설정 (Tauri v2 NSIS 기본 경로 기준)
    const exeFileName = `mhzipy_${version}_x64-setup.exe`;
    const bundleDir = path.resolve(__dirname, '../src-tauri/target/release/bundle/nsis');
    const exePath = path.join(bundleDir, exeFileName);
    const sigPath = `${exePath}.sig`;

    if (!fs.existsSync(exePath) || !fs.existsSync(sigPath)) {
        console.error("❌ 빌드된 파일을 찾을 수 없습니다:", exePath);
        process.exit(1);
    }

    // 3. 서명(Signature) 파일 읽기
    const signature = fs.readFileSync(sigPath, 'utf8').trim();

    // 4. 새로운 update.json 데이터 생성
    const updateJson = {
        version: version,
        notes: `Version ${version} Released!`,
        pub_date: new Date().toISOString(),
        platforms: {
            "windows-x86_64": {
                signature: signature,
                url: `https://mhzipy-update.marh-sw.com/${exeFileName}`
            }
        }
    };

    // 로컬 홈페이지 폴더에도 업데이트 (백업/동기화 용도)
    const localUpdateJsonPath = path.resolve(__dirname, '../../HOMEPAGE/marh-software/homepage-files/update.json');
    if (fs.existsSync(path.dirname(localUpdateJsonPath))) {
        fs.writeFileSync(localUpdateJsonPath, JSON.stringify(updateJson, null, 2));
        console.log("✅ 로컬 update.json 파일 갱신 완료");
    }

    // 5. Cloudflare R2 업로드 (선택 사항 - .env 환경변수 필요)
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucketName = process.env.R2_BUCKET_NAME;

    if (accountId && accessKeyId && secretAccessKey) {
        const s3 = new S3Client({
            region: "auto",
            endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
            credentials: { accessKeyId, secretAccessKey }
        });

        try {
            console.log(`☁️ Cloudflare R2에 ${exeFileName} 업로드 중... (시간이 걸릴 수 있습니다)`);
            const exeStream = fs.createReadStream(exePath);
            await s3.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: exeFileName,
                Body: exeStream,
                ContentType: 'application/x-msdownload'
            }));

            console.log(`☁️ Cloudflare R2에 update.json 업로드 중...`);
            await s3.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: 'update.json', // 루트에 덮어쓰기
                Body: JSON.stringify(updateJson, null, 2),
                ContentType: 'application/json'
            }));

            console.log(`🎉 모든 릴리스 업로드 완료! 버전: ${version}`);
        } catch (err) {
            console.error("❌ R2 업로드 중 오류 발생:", err);
        }
    } else {
        console.log("⚠️ R2 환경 변수가 설정되지 않아 로컬 파일만 갱신했습니다.");
    }
}

run();

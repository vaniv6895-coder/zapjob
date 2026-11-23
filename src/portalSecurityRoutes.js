import crypto from 'crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { pool } from './db.js';
import { getCreatorById } from './portalDb.js';

const RP_NAME = 'Portal VIP';

function getRpConfig(req) {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(':')[0];
  const proto = req.headers['x-forwarded-proto'] || (host === 'localhost' ? 'http' : 'https');
  const origin = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`;
  return { rpID: host, origin };
}

// Guarda desafios temporários na memória (expiram em 5 min)
const challenges = new Map();
function saveChallenge(key, challenge) {
  challenges.set(key, { challenge, expiresAt: Date.now() + 5 * 60 * 1000 });
}
function popChallenge(key) {
  const item = challenges.get(key);
  challenges.delete(key);
  if (!item || item.expiresAt < Date.now()) return null;
  return item.challenge;
}

export async function ensureSecurityTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS creator_passkeys (
      id SERIAL PRIMARY KEY,
      creator_id INTEGER NOT NULL REFERENCES creator_accounts(id) ON DELETE CASCADE,
      credential_id TEXT UNIQUE NOT NULL,
      public_key TEXT NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

export function registerPortalSecurityRoutes(app, requireCreatorAuth, signSessionToken) {
  if (app.__portalSecurityRoutesRegistered) return;
  app.__portalSecurityRoutesRegistered = true;

  ensureSecurityTables().catch((err) => app.log.error(err, '[Security] Erro ao criar tabela creator_passkeys'));

  // 1. Iniciar cadastro de Face ID / Biometria (modelo já logada)
  app.post('/api/portal/webauthn/register-options', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const { rpID } = getRpConfig(req);
    const existing = await pool.query(`SELECT credential_id FROM creator_passkeys WHERE creator_id = $1`, [req.creator.id]);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: req.creator.email,
      userDisplayName: req.creator.stage_name || req.creator.email,
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform', // Força biometria do próprio aparelho (Face ID / Touch ID / Windows Hello)
        userVerification: 'required',
        residentKey: 'preferred',
      },
      excludeCredentials: existing.rows.map((r) => ({ id: r.credential_id })),
    });

    saveChallenge(`reg:${req.creator.id}`, options.challenge);
    return reply.send({ ok: true, options });
  });

  // 2. Confirmar e salvar biometria do celular
  app.post('/api/portal/webauthn/register-verify', { preHandler: requireCreatorAuth }, async (req, reply) => {
    try {
      const { rpID, origin } = getRpConfig(req);
      const expectedChallenge = popChallenge(`reg:${req.creator.id}`);
      if (!expectedChallenge) return reply.status(400).send({ error: 'Desafio expirado. Tente novamente.' });

      const verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });

      if (!verification.verified || !verification.registrationInfo) {
        return reply.status(400).send({ error: 'Falha ao validar biometria.' });
      }

      const { credential } = verification.registrationInfo;
      const pubKeyBase64 = Buffer.from(credential.publicKey).toString('base64');

      await pool.query(
        `INSERT INTO creator_passkeys (creator_id, credential_id, public_key, counter, transports)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (credential_id) DO NOTHING`,
        [req.creator.id, credential.id, pubKeyBase64, credential.counter, JSON.stringify(req.body.response?.transports || [])]
      );

      return reply.send({ ok: true });
    } catch (err) {
      app.log.error(err, '[WebAuthn] Erro no registro biométrico');
      return reply.status(400).send({ error: 'Erro ao ativar biometria: ' + err.message });
    }
  });

  // 3. Iniciar Login com Face ID / Biometria (tela de login)
  app.post('/api/portal/webauthn/login-options', async (req, reply) => {
    const { email } = req.body || {};
    const { rpID } = getRpConfig(req);

    let allowCredentials = [];
    let challengeKey = `login:anon:${crypto.randomBytes(8).toString('hex')}`;

    if (email) {
      const userRes = await pool.query(`SELECT id FROM creator_accounts WHERE LOWER(email) = LOWER($1)`, [String(email).trim()]);
      const user = userRes.rows[0];
      if (!user) return reply.status(404).send({ error: 'Conta não encontrada.' });

      const keysRes = await pool.query(`SELECT credential_id FROM creator_passkeys WHERE creator_id = $1`, [user.id]);
      if (keysRes.rows.length === 0) {
        return reply.status(400).send({ error: 'Esta conta ainda não ativou o Face ID / Biometria.' });
      }
      allowCredentials = keysRes.rows.map((k) => ({ id: k.credential_id }));
      challengeKey = `login:${user.id}`;
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials,
    });

    saveChallenge(options.challenge, options.challenge);
    return reply.send({ ok: true, options, challengeKey });
  });

  // 4. Validar assinatura biométrica e liberar acesso
  app.post('/api/portal/webauthn/login-verify', async (req, reply) => {
    try {
      const { rpID, origin } = getRpConfig(req);
      const { assertion, challenge } = req.body || {};
      const expectedChallenge = popChallenge(challenge);
      if (!expectedChallenge) return reply.status(400).send({ error: 'Sessão biométrica expirada.' });

      const keyRes = await pool.query(`SELECT * FROM creator_passkeys WHERE credential_id = $1`, [assertion?.id]);
      const passkey = keyRes.rows[0];
      if (!passkey) return reply.status(401).send({ error: 'Biometria não reconhecida neste dispositivo.' });

      const verification = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkey.credential_id,
          publicKey: new Uint8Array(Buffer.from(passkey.public_key, 'base64')),
          counter: Number(passkey.counter),
        },
      });

      if (!verification.verified) return reply.status(401).send({ error: 'Assinatura biométrica inválida.' });

      await pool.query(`UPDATE creator_passkeys SET counter = $1 WHERE id = $2`, [
        verification.authenticationInfo.newCounter,
        passkey.id,
      ]);

      const creator = await getCreatorById(passkey.creator_id);
      if (!creator) return reply.status(401).send({ error: 'Conta inativa.' });

      const token = signSessionToken(creator.id);
      return reply.send({ ok: true, token, creator });
    } catch (err) {
      app.log.error(err, '[WebAuthn] Erro no login biométrico');
      return reply.status(401).send({ error: 'Falha na autenticação facial/digital.' });
    }
  });

  // 5. Desafio de Prova de Vida Facial (KYC com código aleatório ao vivo)
  app.get('/api/portal/liveness-challenge', { preHandler: requireCreatorAuth }, async (req, reply) => {
    const actions = [
      'Vire o rosto levemente para a esquerda e sorria',
      'Pisque duas vezes e mostre o código abaixo',
      'Incline a cabeça para a direita e diga o número em voz alta',
    ];
    const code = Math.floor(1000 + Math.random() * 9000);
    const action = actions[Math.floor(Math.random() * actions.length)];
    return reply.send({ ok: true, code, instruction: `${action}: ${code}`, expiresIn: 300 });
  });
}
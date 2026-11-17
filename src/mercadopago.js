import axios from 'axios';

const MP_API = 'https://api.mercadopago.com';

function parseBrlAmount(priceStr) {
  if (!priceStr) return 4.9;
  const cleaned = String(priceStr)
    .replace(/[^\d.,]/g, '')
    .replace(/\.(?=\d{3})/g, '')
    .replace(',', '.');
  const val = parseFloat(cleaned);
  return Number.isFinite(val) && val > 0 ? Number(val.toFixed(2)) : 4.9;
}

export async function createMercadoPagoPix({ channel, userId, priceBr, hours = 24 }) {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) return null;

  const amount = parseBrlAmount(priceBr);
  const externalRef = `${channel}:${userId}:${hours}`;
  const idempotencyKey = `pix_${channel}_${userId}_${Math.floor(Date.now() / 60000)}`;

  const webhookBase =
    process.env.PUBLIC_URL || 'https://zapjob-production.up.railway.app';

  try {
    const res = await axios.post(
      `${MP_API}/v1/payments`,
      {
        transaction_amount: amount,
        description: `Acesso Privado ${hours}h`,
        payment_method_id: 'pix',
        external_reference: externalRef,
        notification_url: `${webhookBase.replace(/\/$/, '')}/webhook/mercadopago`,
        payer: {
          email: `cliente_${String(userId).replace(/\D/g, '') || 'vip'}@atendimento.com`,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
      }
    );

    const txData = res.data?.point_of_interaction?.transaction_data;
    if (txData?.qr_code) {
      return {
        paymentId: res.data.id,
        qrCode: txData.qr_code,
        ticketUrl: txData.ticket_url || null,
        amount,
      };
    }
    return null;
  } catch (err) {
    console.error(
      '[MercadoPago] Erro ao gerar Pix:',
      err?.response?.data || err.message
    );
    return null;
  }
}

export async function createVipPpvPix({ unlockId, priceBr, description = 'Conteudo Exclusivo VIP', customExternalRef }) {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) return null;

  const amount = parseBrlAmount(priceBr);
  const externalRef = customExternalRef || `vip_ppv:${unlockId}`;
  const idempotencyKey = `${externalRef.replace(':', '_')}_${Math.floor(Date.now() / 60000)}`;
  const webhookBase =
    process.env.PUBLIC_URL || 'https://zapjob-production.up.railway.app';

  try {
    const res = await axios.post(
      `${MP_API}/v1/payments`,
      {
        transaction_amount: amount,
        description: description.slice(0, 60),
        payment_method_id: 'pix',
        external_reference: externalRef,
        notification_url: `${webhookBase.replace(/\/$/, '')}/webhook/mercadopago`,
        payer: {
          email: `vip_cliente_${unlockId}@portalvip.com`,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
      }
    );

    const txData = res.data?.point_of_interaction?.transaction_data;
    if (txData?.qr_code) {
      return {
        paymentId: res.data.id,
        qrCode: txData.qr_code,
        qrCodeBase64: txData.qr_code_base64 || null,
        amount,
      };
    }
    return null;
  } catch (err) {
    console.error(
      '[MercadoPago] Erro ao gerar Pix VIP PPV:',
      err?.response?.data || err.message
    );
    return null;
  }
}

export async function getMercadoPagoPayment(paymentId) {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token || !paymentId) return null;

  try {
    const res = await axios.get(`${MP_API}/v1/payments/${paymentId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    return res.data;
  } catch (err) {
    console.error(
      `[MercadoPago] Erro ao consultar pagamento ${paymentId}:`,
      err?.response?.data || err.message
    );
    return null;
  }
}
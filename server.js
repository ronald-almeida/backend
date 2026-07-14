// server.js
// Web Service único no Render que serve:
//   - a landing page (public/index.html)              -> GET /
//   - o checkout                                       -> GET /checkout-delta
//   - o backend do Pix (PayShark)                       -> /api/create-pix, /api/check-status
//
// Tudo no mesmo domínio, então não existe problema de CORS entre
// checkout e backend.

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Serve os arquivos estáticos direto da raiz do projeto (landing page,
// pasta checkout-delta/, imagens, etc. - o que estiver ao lado do server.js)
app.use(express.static(__dirname));

// Rota amigável /checkout-delta -> abre o checkout-delta.html
app.get('/checkout-delta', (req, res) => {
  res.sendFile(path.join(__dirname, 'checkout-delta', 'checkout-delta.html'));
});

// Alias extra, caso alguém acesse com ".html" no final por engano
app.get('/checkout-delta.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'checkout-delta', 'checkout-delta.html'));
});

// Healthcheck em /api/health (não usa "/" pra não conflitar com a landing page)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'pix-backend' });
});

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------
// SEGURANÇA: os preços são fixos aqui no servidor, nunca recebidos
// do front-end. O front só informa se o order bump foi marcado
// (true/false) - ele não manda "quanto custa".
// ---------------------------------------------------------------
const PRECO_PRODUTO_CENTAVOS = 59700; // R$ 597,00
const PRECO_BUMP_CENTAVOS = 9700; // R$ 97,00
const NOME_PRODUTO = 'Acesso Total Delegado de Polícia - 01 Ano';
const NOME_BUMP = 'Acesso Total Delegado de Polícia - 02 Anos';

function validarCPF(cpf) {
  cpf = String(cpf).replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  let soma = 0,
    resto;
  for (let i = 1; i <= 9; i++) soma += parseInt(cpf[i - 1]) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(cpf[9])) return false;
  soma = 0;
  for (let i = 1; i <= 10; i++) soma += parseInt(cpf[i - 1]) * (12 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  return resto === parseInt(cpf[10]);
}

app.post('/api/create-pix', async (req, res) => {
  try {
    const { nome, email, cpf, celular, bumpAtivo, externalRef } = req.body || {};

    if (!nome || typeof nome !== 'string' || nome.trim().length < 3) {
      return res.status(400).json({ error: 'Nome inválido.' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'E-mail inválido.' });
    }
    const cpfLimpo = String(cpf || '').replace(/\D/g, '');
    if (!validarCPF(cpfLimpo)) {
      return res.status(400).json({ error: 'CPF inválido.' });
    }
    const celularLimpo = String(celular || '').replace(/\D/g, '');
    if (celularLimpo.length < 10) {
      return res.status(400).json({ error: 'Celular inválido.' });
    }

    const bumpSelecionado = bumpAtivo === true;

    const items = [
      {
        title: NOME_PRODUTO,
        unitPrice: PRECO_PRODUTO_CENTAVOS,
        quantity: 1,
        tangible: false,
      },
    ];

    let totalCentavos = PRECO_PRODUTO_CENTAVOS;

    if (bumpSelecionado) {
      items.push({
        title: NOME_BUMP,
        unitPrice: PRECO_BUMP_CENTAVOS,
        quantity: 1,
        tangible: false,
      });
      totalCentavos += PRECO_BUMP_CENTAVOS;
    }

    const payload = {
      paymentMethod: 'pix',
      currency: 'BRL',
      amount: totalCentavos,
      items,
      customer: {
        name: nome,
        email,
        phone: celularLimpo,
        document: {
          type: cpfLimpo.length === 11 ? 'cpf' : 'cnpj',
          number: cpfLimpo,
        },
      },
      pix: {
        expiresInDays: 1,
      },
      externalRef: externalRef || `venda-${Date.now()}`,
      // postbackUrl: avisa nosso backend quando o status mudar (ex: pago).
      // Trocamos SEU-APP pela URL real do seu Web Service no Render.
      postbackUrl: 'https://backend-dhvv.onrender.com/api/webhook',
    };

    const secretKey = process.env.PAYSHARK_SECRET_KEY;
    if (!secretKey) {
      console.error('PAYSHARK_SECRET_KEY não configurada nas variáveis de ambiente.');
      return res.status(500).json({ error: 'Configuração do servidor incompleta.' });
    }

    const authHeader = 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');

    const psResponse = await fetch('https://api.paysharkgateway.com.br/v1/transactions', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: authHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await psResponse.json();

    if (!psResponse.ok) {
      console.error('Erro PayShark:', data);
      return res.status(psResponse.status).json({
        error: data?.message || data?.error || 'Erro ao criar transação na PayShark.',
        details: data,
      });
    }

    const qrcode = data?.pix?.qrcode || null;
    const expirationDate = data?.pix?.expirationDate || null;
    const end2EndId = data?.pix?.end2EndId || null;

    if (!qrcode) {
      console.error('Resposta da PayShark sem pix.qrcode:', data);
      return res.status(502).json({
        error: 'Transação criada, mas o Pix não retornou QR Code. Tente novamente.',
        details: data,
      });
    }

    return res.status(200).json({
      id: data.id,
      status: data.status,
      amount: data.amount,
      qrcode,
      expirationDate,
      end2EndId,
    });
  } catch (err) {
    console.error('Erro inesperado em /api/create-pix:', err);
    return res.status(500).json({ error: 'Erro interno ao gerar o Pix. Tente novamente.' });
  }
});

app.get('/api/check-status', async (req, res) => {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Parâmetro "id" é obrigatório.' });
  }

  const secretKey = process.env.PAYSHARK_SECRET_KEY;
  if (!secretKey) {
    console.error('PAYSHARK_SECRET_KEY não configurada.');
    return res.status(500).json({ error: 'Configuração do servidor incompleta.' });
  }

  const authHeader = 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');

  try {
    const psResponse = await fetch(`https://api.paysharkgateway.com.br/v1/transactions/${id}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: authHeader,
      },
    });

    const data = await psResponse.json();

    if (!psResponse.ok) {
      console.error('Erro ao consultar status na PayShark:', data);
      return res.status(psResponse.status).json({
        error: data?.message || 'Erro ao consultar status da transação.',
      });
    }

    const statusBruto = (data?.status || '').toLowerCase();
    const pago = statusBruto === 'paid';

    return res.status(200).json({
      id: data.id,
      statusBruto: data.status,
      status: pago ? 'paid' : statusBruto,
    });
  } catch (err) {
    console.error('Erro inesperado em /api/check-status:', err);
    return res.status(500).json({ error: 'Erro interno ao consultar status.' });
  }
});

// ---------------------------------------------------------------
// WEBHOOK: a PayShark chama essa rota automaticamente quando o status
// de uma transação muda (ex: pix gerado -> pago). Configuramos isso
// mandando "postbackUrl" na criação da transação (ver /api/create-pix).
//
// ATENÇÃO - itens a confirmar na doc de Webhooks da PayShark:
//   1. Formato exato do body que eles enviam (assumindo que é o mesmo
//      objeto de transação que a gente já viu em "Criar Venda" / "Buscar Venda").
//   2. Como validar que a requisição realmente veio da PayShark
//      (assinatura em header, token secreto, etc.) - ainda não implementado,
//      então por enquanto QUALQUER UM pode chamar essa rota fingindo ser
//      a PayShark. Não usar em produção sem essa validação.
// ---------------------------------------------------------------
app.post('/api/webhook', async (req, res) => {
  try {
    const evento = req.body;
    console.log('Webhook recebido da PayShark:', JSON.stringify(evento));

    // TODO: validar autenticidade da chamada (assinatura/token) antes de confiar nela

    const status = (evento?.status || '').toLowerCase();
    const transacaoId = evento?.id;

    if (status === 'paid') {
      // TODO: aqui é onde você libera o acesso do cliente de verdade:
      // - marcar a compra como paga no seu banco de dados / planilha
      // - enviar e-mail/mensagem com o acesso ao curso
      // - notificar quem estiver acompanhando o pagamento em tempo real
      console.log(`✅ Transação ${transacaoId} confirmada como paga.`);
    }

    // Sempre responder 200 rápido - a PayShark pode re-tentar se não receber OK
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Erro ao processar webhook:', err);
    return res.status(500).json({ error: 'Erro ao processar webhook.' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

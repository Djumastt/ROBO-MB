const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');

// Conexão com o Supabase
const supabaseUrl = 'https://wcypssyxwsntlscswers.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURAÇÃO DAS FILAS (Mãe + 9 Filas Filhas)
// ==========================================
const TABELAS_FILA_SMS = [
    'fila_sms',   // Dispositivo 1 (Fila Mãe - Sempre ativa)
    'fila_sms_1', // Dispositivo 2
    'fila_sms_2', // Dispositivo 3
    'fila_sms_3', // Dispositivo 4
    'fila_sms_4', // Dispositivo 5
    'fila_sms_5', // Dispositivo 6
    'fila_sms_6', // Dispositivo 7
    'fila_sms_7', // Dispositivo 8
    'fila_sms_8', // Dispositivo 9
    'fila_sms_9'  // Dispositivo 10
];

// Mapeamento Fila -> Nome do Dispositivo
const MAPA_DISPOSITIVOS = {
    fila_sms: 'Dispositivo 1',
    fila_sms_1: 'Dispositivo 2',
    fila_sms_2: 'Dispositivo 3',
    fila_sms_3: 'Dispositivo 4',
    fila_sms_4: 'Dispositivo 5',
    fila_sms_5: 'Dispositivo 6',
    fila_sms_6: 'Dispositivo 7',
    fila_sms_7: 'Dispositivo 8',
    fila_sms_8: 'Dispositivo 9',
    fila_sms_9: 'Dispositivo 10'
};

// O seu número pessoal/do agente (que deve ser ignorado como destino de megas)
const MEU_NUMERO_VODACOM = '856597911';

// Estado global de ativação das filas filhas
const estadoFilas = {
    fila_sms_1: false,
    fila_sms_2: false,
    fila_sms_3: false,
    fila_sms_4: false,
    fila_sms_5: false,
    fila_sms_6: false,
    fila_sms_7: false,
    fila_sms_8: false,
    fila_sms_9: false
};

// Estado interativo do comando .addnr no WhatsApp (por utilizador)
const sessoesAddNr = new Map();
const TEMPO_EXPIRACAO_SESSAO_MS = 2 * 60 * 1000; // 2 minutos

function normalizarNumeroMZ(numero) {
    const digitos = String(numero || '').replace(/\D/g, '');
    if (digitos.startsWith('258') && digitos.length === 12) {
        return digitos.slice(3);
    }
    return digitos;
}

function telefoneValidoParaSMS(numero) {
    const limpo = normalizarNumeroMZ(numero);
    return /^8[4567]\d{7}$/.test(limpo) ? limpo : null;
}

async function enviarSmsCliente(destino, mensagem) {
    const tel = telefoneValidoParaSMS(destino);
    if (!tel || !mensagem) return;

    const { error } = await supabase.from('sms_saida').insert([{
        telefone: String(tel),
        mensagem: String(mensagem),
        status: 'pendente'
    }]);

    if (error) {
        console.log(`❌ [SMS_SAIDA] Erro ao agendar SMS para ${tel}:`, error.message);
    } else {
        console.log(`📨 [SMS_SAIDA] Mensagem agendada para ${tel}.`);
    }
}

function extrairReferencia(texto) {
    const matchIdTransacao = texto.match(/ID\s+(?:da\s+)?transa[cç][aã]o[:\s]+([A-Z0-9.]+)/i);
    if (matchIdTransacao) {
        return matchIdTransacao[1].replace(/\.$/, '').trim();
    }

    const matchConfirmado = texto.match(/\bConfirmado\s+([A-Z0-9.]+)/i);
    if (matchConfirmado) {
        return matchConfirmado[1].replace(/\.$/, '').trim();
    }

    const matchRef = texto.match(/(ID Trans|Transacao|Transação|Ref)[:\s]+([A-Z0-9.]+)/i);
    if (matchRef) {
        return matchRef[2].replace(/\.$/, '').trim();
    }

    return "NAO_ENCONTRADA";
}

function extrairValorMT(texto) {
    const matchValor = texto.match(/(\d+([.,]\d+)?)\s*MT/i);
    if (matchValor) {
        return parseFloat(matchValor[1].replace(',', '.')).toString();
    }
    return '0';
}

function extrairDestinoComprovativo(texto, meuNumero) {
    // 1. Tenta explicitamente em "conteudo: 84/85..."
    const matchConteudo = texto.match(/conteudo[:\s]+(258)?(8[45]\d{7})/i);
    if (matchConteudo) {
        const num = normalizarNumeroMZ(matchConteudo[2]);
        if (num && num !== meuNumero) return num;
    }

    // 2. Procura números de 9 dígitos (com ou sem 258) no texto / linhas
    const candidatos = [];
    const regexNums = /(?:258)?(8[4567]\d{7})/g;
    let m;
    while ((m = regexNums.exec(texto)) !== null) {
        const normalizado = normalizarNumeroMZ(m[1]);
        if (normalizado) candidatos.push(normalizado);
    }

    // Prioriza números Vodacom (84/85) que não sejam o número do agente
    const vodacomValidos = candidatos.filter(n => /^8[45]\d{7}$/.test(n) && n !== meuNumero);
    if (vodacomValidos.length > 0) {
        return vodacomValidos[vodacomValidos.length - 1];
    }

    return null;
}

async function processarPedidoValidado({
    itemId,
    referencia,
    valorConfirmado,
    clientePagador,
    numeroDestinatario,
    viaAutoEnvio = false
}) {
    if (!numeroDestinatario || !/^8[45]\d{7}$/.test(numeroDestinatario) || numeroDestinatario === MEU_NUMERO_VODACOM) {
        await supabase.from('sms_entrada').update({
            status: 'rejeitado_sem_vodacom',
            referencia,
            valor: String(valorConfirmado)
        }).eq('id', itemId);

        await enviarSmsCliente(
            clientePagador,
            'Nao foi identificado um numero Vodacom valido para receber os megas. Envie o comprovativo com o numero de destino (ex: 84/85xxxxxxx).'
        );
        return false;
    }

    if (referencia === "NAO_ENCONTRADA") {
        await supabase.from('sms_entrada').update({
            status: 'rejeitado_sem_ref',
            valor: String(valorConfirmado)
        }).eq('id', itemId);

        await enviarSmsCliente(
            clientePagador,
            'Comprovativo invalido ou sem referencia identificada. Verifique a mensagem e tente novamente.'
        );
        return false;
    }

    const { data: jaUsado } = await supabase
        .from('memoria_aguardando')
        .select('*')
        .eq('referencia', referencia)
        .maybeSingle();

    if (jaUsado) {
        await supabase.from('sms_entrada').update({
            status: 'duplicado',
            referencia,
            valor: String(valorConfirmado)
        }).eq('id', itemId);

        await enviarSmsCliente(
            clientePagador,
            `Este comprovativo (Ref: ${referencia}) ja foi utilizado anteriormente.`
        );
        return false;
    }

    const { data: transacaoReal } = await supabase
        .from('transecoes_pendentes')
        .select('*')
        .eq('referencia', referencia)
        .maybeSingle();

    if (!transacaoReal) {
        await supabase.from('sms_entrada').update({
            status: 'nao_encontrado',
            referencia,
            valor: String(valorConfirmado)
        }).eq('id', itemId);

        await enviarSmsCliente(
            clientePagador,
            `Comprovativo invalido ou transacao (Ref: ${referencia}) nao encontrada no sistema.`
        );
        return false;
    }

    await supabase.from('sms_entrada').update({
        status: 'processado',
        referencia,
        valor: String(valorConfirmado)
    }).eq('id', itemId);

    await supabase.from('sms_macro').insert([{
        referencia,
        valor: valorConfirmado,
        sender: String(clientePagador)
    }]);

    await supabase.from('memoria_aguardando').insert([{
        sender: String(clientePagador),
        valor: valorConfirmado,
        referencia
    }]);

    await supabase.from('transecoes_pendentes').update({ status: 'concluido' }).eq('id', transacaoReal.id);

    const { data: preco } = await supabase
        .from('tabela_precos')
        .select('megas')
        .eq('valor', valorConfirmado)
        .maybeSingle();

    const pacoteMegas = preco?.megas || 'N/A';

    await inserirNaFilaSMS({
        telefone: numeroDestinatario,
        pacote: pacoteMegas,
        status: 'pendente',
        sender: String(clientePagador),
        referencia: referencia
    });

    // SMS enviado para o cliente que pagou
    await enviarSmsCliente(
        clientePagador,
        'Pedido Recebido! Aguarde uns instantes enquanto o sistema processa o seu pedido!'
    );

    // Notificação no grupo WhatsApp
    if (globalSock) {
        const etiquetaAuto = viaAutoEnvio ? ' ⚡ *(Auto-Envio)*' : '';
        const msgGrupo = `✅ *Pedido Recebido!*${etiquetaAuto}\n\n💰 *Referência:* ${referencia}\n📊 *Megas:* ${pacoteMegas}\n📱 *Número:* ${numeroDestinatario}\n\n_⏳Processando... Aguarde enquanto o Sistema executa a transferência_`;
        await globalSock.sendMessage(GRUPO_AUTORIZADO, { text: msgGrupo });
    }

    return true;
}

let indiceUltimaFilaSMS = 0;

// Lógica de rotação cíclica: Mãe ➔ Filas Ativas ➔ Mãe
async function obterProximaTabelaFilaSMS() {
    let tabelasAtivas = ['fila_sms'];
    for (let i = 1; i <= 9; i++) {
        let nomeFila = `fila_sms_${i}`;
        if (estadoFilas[nomeFila]) {
            tabelasAtivas.push(nomeFila);
        }
    }

    indiceUltimaFilaSMS = indiceUltimaFilaSMS % tabelasAtivas.length;
    let tabelaEscolhida = tabelasAtivas[indiceUltimaFilaSMS];
    indiceUltimaFilaSMS = (indiceUltimaFilaSMS + 1) % tabelasAtivas.length;

    return tabelaEscolhida;
}

async function inserirNaFilaSMS(dadosPedido) {
    const tabelaDestino = await obterProximaTabelaFilaSMS();
    const { error } = await supabase.from(tabelaDestino).insert([dadosPedido]);
    if (error) {
        console.log(`❌ [FILA] Erro ao inserir na tabela ${tabelaDestino}:`, error.message);
    } else {
        console.log(`✅ [FILA] Pedido direcionado com sucesso em ordem para: ${tabelaDestino} (${MAPA_DISPOSITIVOS[tabelaDestino]})`);
    }
    return tabelaDestino;
}

// ==========================================
// 1. ROTA DE INGESTÃO (Recebe do MacroDroid)
// ==========================================
app.post('/sms-recebido', async (req, res) => {
    console.log("\n--------------------------------------------------");
    console.log("📥 [TERMINAL] Requisição POST recebida em /sms-recebido!");
    console.log("📦 [TERMINAL] Dados crus recebidos:", req.body);

    try {
        const sender = req.body.sender || req.body.telefone || req.body.from;
        const mensagem = req.body.mensagem || req.body.text || req.body.body;

        if (!sender || !mensagem) {
            console.log("⚠️ [TERMINAL] ERRO: Sender ou mensagem em falta no corpo do pedido!");
            return res.status(400).json({ erro: 'Sender e mensagem obrigatórios' });
        }

        const { error } = await supabase.from('sms_entrada').insert([{
            sender: String(sender),
            receber: String(mensagem),
            referencia: 'PENDENTE',
            valor: '0',
            status: 'pendente'
        }]);

        if (error) {
            console.log("❌ [TERMINAL] Erro ao guardar SMS bruto no Supabase:", error.message);
            return res.status(500).json({ erro: error.message });
        }

        console.log(`✅ [TERMINAL] SMS bruto de [${sender}] guardado na tabela 'sms_entrada' com sucesso!`);
        return res.json({ status: 'sucesso', mensagem: 'SMS guardado para processamento' });

    } catch (err) {
        console.log("❌ [TERMINAL] Erro crítico na rota /sms-recebido:", err.message);
        return res.status(500).json({ erro: err.message });
    }
});

// Referência global do socket do WhatsApp para envio direto de mensagens para o grupo
let globalSock = null;
const GRUPO_AUTORIZADO = '120363430210835977@g.us';

// ==========================================
// 2. O ROBÔ PROCESSADOR (Background Worker)
// ==========================================
function iniciarRoboProcessamentoSMS() {
    setInterval(async () => {
        try {
            const { data: pendentes, error } = await supabase
                .from('sms_entrada')
                .select('*')
                .eq('status', 'pendente')
                .limit(1);

            if (!error && pendentes && pendentes.length > 0) {
                const item = pendentes[0];

                // Bloqueio atômico imediato para evitar duplicações
                const { data: bloqueado } = await supabase
                    .from('sms_entrada')
                    .update({ status: 'processando' })
                    .eq('id', item.id)
                    .eq('status', 'pendente')
                    .select();

                if (!bloqueado || bloqueado.length === 0) return;

                const texto = String(item.receber || '').trim();
                const textoLower = texto.toLowerCase();
                const sender = normalizarNumeroMZ(item.sender) || String(item.sender);

                if (textoLower === 'tabela' || textoLower === 'pagamento') {
                    const { data: cmdData } = await supabase
                        .from('comandos_customizados')
                        .select('resposta')
                        .eq('comando', textoLower)
                        .maybeSingle();

                    if (cmdData && cmdData.resposta) {
                        await enviarSmsCliente(sender, cmdData.resposta);
                    }

                    await supabase.from('sms_entrada').update({ status: 'respondido' }).eq('id', item.id);
                    return;
                }

                const ehComprovativoEnviado = textoLower.includes("confirmado") ||
                                              textoLower.includes("transacao") ||
                                              textoLower.includes("transação") ||
                                              textoLower.includes("ref") ||
                                              textoLower.includes("transferiste");

                const ehRecebimentoDireto = textoLower.includes("recebeu") || textoLower.includes("id trans");

                if (texto.length < 10 || (!ehComprovativoEnviado && !ehRecebimentoDireto)) {
                    await supabase.from('sms_entrada').update({ status: 'ignorado' }).eq('id', item.id);
                    return;
                }

                // -------------------------------------------------------------
                // CASO A: SMS DE RECEBIMENTO DIRETO (com suporte a AUTOENVIO)
                // -------------------------------------------------------------
                if (ehRecebimentoDireto) {
                    const referencia = extrairReferencia(texto);
                    const valorConfirmado = extrairValorMT(texto);

                    let clientePagador = null;
                    const matchPagador = texto.match(/Recebeu\s+[\d.,]+\s*MT\s+de\s+(?:258)?(8[4567]\d{7})/i);
                    if (matchPagador) {
                        clientePagador = matchPagador[1];
                    } else {
                        const numsGerais = texto.match(/\b(?:258)?(8[4567]\d{7})\b/g) || [];
                        if (numsGerais.length > 0) clientePagador = numsGerais[0];
                    }
                    clientePagador = normalizarNumeroMZ(clientePagador) || sender;

                    // 1. Verifica se o pagador está registado na tabela 'autoenvio'
                    let numeroDestinatario = null;
                    let viaAutoEnvio = false;

                    if (clientePagador) {
                        const { data: regAutoEnvio } = await supabase
                            .from('autoenvio')
                            .select('nr_receber')
                            .eq('nr_pagamento', clientePagador)
                            .maybeSingle();

                        if (regAutoEnvio && regAutoEnvio.nr_receber) {
                            numeroDestinatario = normalizarNumeroMZ(regAutoEnvio.nr_receber);
                            viaAutoEnvio = true;
                            console.log(`⚡ [AUTOENVIO] Número ${clientePagador} encontrado -> Destino automático: ${numeroDestinatario}`);
                        }
                    }

                    // 2. Se não estiver no autoenvio, procura no conteúdo da mensagem
                    if (!numeroDestinatario) {
                        const matchConteudo = texto.match(/conteudo[:\s]+(?:258)?(8[45]\d{7})/i);
                        if (matchConteudo) {
                            numeroDestinatario = normalizarNumeroMZ(matchConteudo[1]);
                        }
                    }

                    await processarPedidoValidado({
                        itemId: item.id,
                        referencia,
                        valorConfirmado,
                        clientePagador,
                        numeroDestinatario,
                        viaAutoEnvio
                    });
                    return;
                }

                // -------------------------------------------------------------
                // CASO B: COMPROVATIVO ENVIADO ("Transferiste" / "Confirmado")
                // -------------------------------------------------------------
                if (ehComprovativoEnviado) {
                    const referencia = extrairReferencia(texto);
                    const valorConfirmado = extrairValorMT(texto);
                    const numeroDestinatario = extrairDestinoComprovativo(texto, MEU_NUMERO_VODACOM);

                    // Se não vier com número destinatário válido, ignora e avisa o cliente
                    if (!numeroDestinatario) {
                        await supabase.from('sms_entrada').update({
                            status: 'ignorado',
                            referencia,
                            valor: String(valorConfirmado)
                        }).eq('id', item.id);

                        await enviarSmsCliente(
                            sender,
                            'Envie o comprovativo acompanhado do numero Vodacom que vai receber os megas (ex: 84/85xxxxxxx).'
                        );
                        return;
                    }

                    await processarPedidoValidado({
                        itemId: item.id,
                        referencia,
                        valorConfirmado,
                        clientePagador: sender,
                        numeroDestinatario,
                        viaAutoEnvio: false
                    });
                    return;
                }
            }

            // =========================================================
            // PARTE C: VERIFICAR 'sms_concluidos' (Gravado pelo Macrodroid)
            // =========================================================
            const { data: concluidosPeloMacro, error: errConcluidos } = await supabase
                .from('sms_concluidos')
                .select('*')
                .limit(3);

            if (!errConcluidos && concluidosPeloMacro && concluidosPeloMacro.length > 0) {
                for (let itemConcluido of concluidosPeloMacro) {
                    const referencia = String(itemConcluido.referencia || '').trim();
                    const clienteSender = itemConcluido.sender;
                    const telefoneDestino = itemConcluido.receber || itemConcluido.telefone;
                    const valorTransacao = itemConcluido.valor;

                    if (!referencia || referencia === 'undefined') {
                        await supabase.from('sms_concluidos').delete().eq('id', itemConcluido.id);
                        continue;
                    }

                    let encontradoNaFila = false;
                    let tabelaEncontrada = null;
                    let registoFila = null;

                    for (let tabelaFila of TABELAS_FILA_SMS) {
                        const { data: filaData } = await supabase
                            .from(tabelaFila)
                            .select('*')
                            .eq('referencia', referencia)
                            .maybeSingle();

                        if (filaData) {
                            encontradoNaFila = true;
                            tabelaEncontrada = tabelaFila;
                            registoFila = filaData;
                            break;
                        }
                    }

                    if (encontradoNaFila && registoFila) {
                        await supabase
                            .from(tabelaEncontrada)
                            .update({ status: 'concluido' })
                            .eq('id', registoFila.id);

                        const { data: preco } = await supabase
                            .from('tabela_precos')
                            .select('megas')
                            .eq('valor', valorTransacao)
                            .maybeSingle();

                        const pacoteMegas = preco?.megas || registoFila.pacote || 'N/A';
                        const telefoneFinal = telefoneDestino || registoFila.telefone || 'N/A';
                        const senderFinal = clienteSender || registoFila.sender;
                        const nomeDispositivo = MAPA_DISPOSITIVOS[tabelaEncontrada] || 'Dispositivo 1';
                        const dataHoraAtual = new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' });

                        const msgConcluidoFinal = `✅ *Transação Concluída Com Sucesso*\n\n💰 *Referência:* ${referencia}\n📱 Telefone: ${telefoneFinal}\n📊 Pacote: ${pacoteMegas}\n⏰ Data/Hora: ${dataHoraAtual}\n📱 Finalizado: ${nomeDispositivo}\n\n_Transferencia Processada Automáticamente Pelo Sistema_`;

                        if (senderFinal) {
                            await enviarSmsCliente(senderFinal, msgConcluidoFinal);
                        }

                        if (globalSock) {
                            await globalSock.sendMessage(GRUPO_AUTORIZADO, { text: msgConcluidoFinal });
                        }

                        await supabase.from('sms_concluidos').delete().eq('id', itemConcluido.id);
                        console.log(`🧹 [SMS_CONCLUIDOS] Registo ${referencia} (${nomeDispositivo}) limpo com sucesso!`);
                    } else {
                        await supabase.from('sms_concluidos').delete().eq('id', itemConcluido.id);
                    }
                }
            }

        } catch (err) {
            console.log("❌ [ROBÔ] Erro no ciclo de processamento:", err.message);
        }
    }, 4000);
}

// ==========================================
// ROTA: CONSULTAR SMS PENDENTES DE SAÍDA
// ==========================================
app.get('/sms-saida', async (req, res) => {
    try {
        const { data: pendentes, error } = await supabase
            .from('sms_saida')
            .select('*')
            .eq('status', 'pendente')
            .limit(5);

        if (error) return res.status(500).json({ erro: error.message });

        if (pendentes && pendentes.length > 0) {
            const ids = pendentes.map(p => p.id);
            await supabase.from('sms_saida').update({ status: 'enviado' }).in('id', ids);
            console.log(`📤 [TERMINAL] Macrodroid consultou a saída. Enviados ${ids.length} registos.`);
        }

        return res.json(pendentes || []);
    } catch (err) {
        return res.status(500).json({ erro: err.message });
    }
});

// ==========================================
// 3. CONFIGURAÇÃO DO BOT DO WHATSAPP (Baileys)
// ==========================================
async function iniciarWhatsAppBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        browser: ['Ubuntu', 'Chrome', '122.0.6261.111'],
        markOnlineOnConnect: false,
        logger: pino({ level: 'silent' })
    });

    globalSock = sock;

    sock.ev.on('creds.update', saveCreds);

    if (!state.creds.registered) {
        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'connecting') {
                await new Promise(resolve => setTimeout(resolve, 3000));

                const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
                readline.question('\n📱 Digite seu número com DDI (ex: 25884xxxxxxx): ', async (phoneNumber) => {
                    readline.close();
                    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                    try {
                        const code = await sock.requestPairingCode(cleanNumber);
                        console.log(`\n================================`);
                        console.log(`🔑 CÓDIGO DE PAREAMENTO: ${code}`);
                        console.log(`================================\n`);
                    } catch (err) {
                        console.error("❌ Erro ao solicitar código:", err.message);
                    }
                });
            }
        });
    } else {
        console.log('📂 Sessão do WhatsApp carregada automaticamente a partir da pasta auth_info!');
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) iniciarWhatsAppBot();
        } else if (connection === 'open') {
            console.log('✅ ROBÔ WHATSAPP ONLINE E CONECTADO AO GRUPO!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const remoteJid = m.key.remoteJid;
        const participante = m.key.participant || remoteJid;
        const textoMsg = m.message.conversation || m.message.extendedTextMessage?.text || '';

        if (remoteJid.endsWith('@g.us')) {
            console.log(`📌 Grupo detetado ID: ${remoteJid}`);
        }

        if (!remoteJid.endsWith('@g.us') || remoteJid !== GRUPO_AUTORIZADO) {
            return;
        }

        const textoLimpo = textoMsg.trim();
        const comando = textoLimpo.toLowerCase();

        // -------------------------------------------------------------
        // COMANDO .vernr (Listar todos ou consultar um número específico)
        // -------------------------------------------------------------
        if (comando === '.vernr' || comando.startsWith('.vernr ')) {
            const argumentoBruto = textoLimpo.slice(6).trim();

            if (!argumentoBruto) {
                const { data: lista, error } = await supabase
                    .from('autoenvio')
                    .select('nr_pagamento, nr_receber')
                    .order('id', { ascending: true });

                if (error) {
                    await sock.sendMessage(remoteJid, {
                        text: `❌ Erro ao consultar a tabela *autoenvio*: ${error.message}`
                    });
                    return;
                }

                if (!lista || lista.length === 0) {
                    await sock.sendMessage(remoteJid, {
                        text: '📭 Nenhum número cadastrado no *auto-envio* no momento.'
                    });
                    return;
                }

                const linhas = lista.map((item, idx) =>
                    `${idx + 1}. 💳 Paga: *${item.nr_pagamento}* ➔ 📲 Recebe: *${item.nr_receber}*`
                );

                await sock.sendMessage(remoteJid, {
                    text: `📋 *NÚMEROS DE AUTO-ENVIO (${lista.length})*\n\n${linhas.join('\n')}`
                });
                return;
            }

            const numeroConsulta = normalizarNumeroMZ(argumentoBruto);
            if (!/^\d{9}$/.test(numeroConsulta)) {
                await sock.sendMessage(remoteJid, {
                    text: '⚠️ Número inválido para consulta. Use: `.vernr 877123363`'
                });
                return;
            }

            const { data: encontrados, error } = await supabase
                .from('autoenvio')
                .select('nr_pagamento, nr_receber')
                .or(`nr_pagamento.eq.${numeroConsulta},nr_receber.eq.${numeroConsulta}`);

            if (error) {
                await sock.sendMessage(remoteJid, {
                    text: `❌ Erro ao consultar o número *${numeroConsulta}*: ${error.message}`
                });
                return;
            }

            if (!encontrados || encontrados.length === 0) {
                await sock.sendMessage(remoteJid, {
                    text: `❌ O número *${numeroConsulta}* *NÃO* está na lista de auto-envio (nem como pagador nem como receptor).`
                });
                return;
            }

            const detalhes = encontrados.map((item) => {
                const papeis = [];
                if (item.nr_pagamento === numeroConsulta) papeis.push('💳 *Paga*');
                if (item.nr_receber === numeroConsulta) papeis.push('📲 *Recebe Megas*');
                return `• Papel: ${papeis.join(' e ')}\n  💳 Paga: *${item.nr_pagamento}* ➔ 📲 Recebe: *${item.nr_receber}*`;
            });

            await sock.sendMessage(remoteJid, {
                text: `✅ *Número *${numeroConsulta}* Encontrado no Auto-Envio!*\n\n${detalhes.join('\n\n')}`
            });
            return;
        }

        // -------------------------------------------------------------
        // FLUXO INTERATIVO DO COMANDO .addnr
        // -------------------------------------------------------------
        if (comando === '.addnr') {
            sessoesAddNr.set(participante, {
                etapa: 'ESCOLHER_ACAO',
                expiraEm: Date.now() + TEMPO_EXPIRACAO_SESSAO_MS
            });

            await sock.sendMessage(remoteJid, {
                text: `⚙️ *CONFIGURAÇÃO DE AUTO-ENVIO*\n\nQual operação deseja realizar?\n\n1️⃣ *Adicionar* número\n2️⃣ *Excluir* número\n\n_Responda com *1* (ou *adicionar*), *2* (ou *excluir*), ou digite *cancelar*._`
            });
            return;
        }

        if (sessoesAddNr.has(participante)) {
            const sessao = sessoesAddNr.get(participante);

            if (Date.now() > sessao.expiraEm) {
                sessoesAddNr.delete(participante);
            } else if (!comando.startsWith('.')) {
                if (comando === 'cancelar') {
                    sessoesAddNr.delete(participante);
                    await sock.sendMessage(remoteJid, { text: '❌ Operação de auto-envio cancelada.' });
                    return;
                }

                if (sessao.etapa === 'ESCOLHER_ACAO') {
                    if (comando === '1' || comando === 'adicionar') {
                        sessao.etapa = 'AGUARDAR_NR_PAGAMENTO';
                        sessao.expiraEm = Date.now() + TEMPO_EXPIRACAO_SESSAO_MS;
                        await sock.sendMessage(remoteJid, {
                            text: '📥 Digite o *número que vai enviar o dinheiro* (ex: `841234567` ou `851234567`):'
                        });
                        return;
                    }

                    if (comando === '2' || comando === 'excluir') {
                        sessao.etapa = 'AGUARDAR_NR_EXCLUIR';
                        sessao.expiraEm = Date.now() + TEMPO_EXPIRACAO_SESSAO_MS;
                        await sock.sendMessage(remoteJid, {
                            text: '🗑️ Digite o *número que deseja excluir* do auto-envio:'
                        });
                        return;
                    }

                    await sock.sendMessage(remoteJid, {
                        text: '⚠️ Opção inválida. Responda com *1* (Adicionar), *2* (Excluir) ou *cancelar*.'
                    });
                    return;
                }

                if (sessao.etapa === 'AGUARDAR_NR_PAGAMENTO') {
                    const nrPagamento = normalizarNumeroMZ(textoLimpo);
                    if (!/^8[4567]\d{7}$/.test(nrPagamento)) {
                        await sock.sendMessage(remoteJid, {
                            text: '⚠️ Número inválido. Digite um número moçambicano válido com 9 dígitos (ex: `841234567`):'
                        });
                        return;
                    }

                    sessao.nrPagamento = nrPagamento;
                    sessao.etapa = 'AGUARDAR_NR_RECEBER';
                    sessao.expiraEm = Date.now() + TEMPO_EXPIRACAO_SESSAO_MS;

                    await sock.sendMessage(remoteJid, {
                        text: `✅ Número de pagamento registado: *${nrPagamento}*\n\n📲 Agora digite o *número Vodacom que vai receber os megas* (ex: \`841234567\` ou \`851234567\`):`
                    });
                    return;
                }

                if (sessao.etapa === 'AGUARDAR_NR_RECEBER') {
                    const nrReceber = normalizarNumeroMZ(textoLimpo);
                    if (!/^8[45]\d{7}$/.test(nrReceber)) {
                        await sock.sendMessage(remoteJid, {
                            text: '⚠️ Número de destino inválido. Digite um número Vodacom válido (`84` ou `85` com 9 dígitos):'
                        });
                        return;
                    }

                    const nrPagamento = sessao.nrPagamento;
                    sessoesAddNr.delete(participante);

                    const { data: existente } = await supabase
                        .from('autoenvio')
                        .select('id')
                        .eq('nr_pagamento', nrPagamento)
                        .maybeSingle();

                    let erroDb = null;
                    if (existente) {
                        const { error } = await supabase
                            .from('autoenvio')
                            .update({ nr_receber: nrReceber })
                            .eq('id', existente.id);
                        erroDb = error;
                    } else {
                        const { error } = await supabase
                            .from('autoenvio')
                            .insert([{ nr_pagamento: nrPagamento, nr_receber: nrReceber }]);
                        erroDb = error;
                    }

                    if (erroDb) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Erro ao guardar no banco de dados: ${erroDb.message}`
                        });
                    } else {
                        await sock.sendMessage(remoteJid, {
                            text: `✅ *Auto-Envio Configurado com Sucesso!*\n\n💳 *Pagador:* ${nrPagamento}\n📲 *Recebe Megas:* ${nrReceber}`
                        });
                    }
                    return;
                }

                if (sessao.etapa === 'AGUARDAR_NR_EXCLUIR') {
                    const nrExcluir = normalizarNumeroMZ(textoLimpo);
                    if (!/^\d{9}$/.test(nrExcluir)) {
                        await sock.sendMessage(remoteJid, {
                            text: '⚠️ Número inválido. Digite os 9 dígitos do número que pretende excluir:'
                        });
                        return;
                    }

                    sessoesAddNr.delete(participante);

                    const { data: removidos, error: erroDel } = await supabase
                        .from('autoenvio')
                        .delete()
                        .or(`nr_pagamento.eq.${nrExcluir},nr_receber.eq.${nrExcluir}`)
                        .select();

                    if (erroDel) {
                        await sock.sendMessage(remoteJid, {
                            text: `❌ Erro ao excluir do banco de dados: ${erroDel.message}`
                        });
                    } else if (!removidos || removidos.length === 0) {
                        await sock.sendMessage(remoteJid, {
                            text: `⚠️ Nenhum registo encontrado na tabela *autoenvio* para o número *${nrExcluir}*.`
                        });
                    } else {
                        await sock.sendMessage(remoteJid, {
                            text: `🗑️ *Auto-Envio Removido com Sucesso!*\n\nNúmero *${nrExcluir}* excluído (${removidos.length} registo(s) removido(s)).`
                        });
                    }
                    return;
                }
            }
        }

        // -------------------------------------------------------------
        // COMANDOS DE CONTROLO DAS FILAS
        // -------------------------------------------------------------
        if (comando.startsWith('.ativafila')) {
            const numeroFila = comando.replace('.ativafila', '').trim();
            const nomeTabela = `fila_sms_${numeroFila}`;
            if (estadoFilas.hasOwnProperty(nomeTabela)) {
                estadoFilas[nomeTabela] = true;
                await sock.sendMessage(remoteJid, { text: `🟢 Fila ${numeroFila} (${nomeTabela} - ${MAPA_DISPOSITIVOS[nomeTabela]}) foi ATIVADA com sucesso!` });
            }
        }

        if (comando.startsWith('.desativafila')) {
            const numeroFila = comando.replace('.desativafila', '').trim();
            const nomeTabela = `fila_sms_${numeroFila}`;
            if (estadoFilas.hasOwnProperty(nomeTabela)) {
                estadoFilas[nomeTabela] = false;
                await sock.sendMessage(remoteJid, { text: `🔴 Fila ${numeroFila} (${nomeTabela} - ${MAPA_DISPOSITIVOS[nomeTabela]}) foi DESATIVADA.` });
            }
        }

        if (comando.startsWith('.onfila')) {
            const numeroFila = comando.replace('.onfila', '').trim();
            const nomeTabela = `fila_sms_${numeroFila}`;

            if (estadoFilas.hasOwnProperty(nomeTabela)) {
                const estaAtiva = estadoFilas[nomeTabela];

                const { count } = await supabase
                    .from(nomeTabela)
                    .select('*', { count: 'exact', head: true })
                    .eq('status', 'pendente');

                const statusTexto = estaAtiva ? '🟢 ATIVA' : '🔴 DESATIVADA';
                const respostaStatus = `📊 *STATUS DA FILA ${numeroFila}*\n\n📌 Tabela: \`${nomeTabela}\` (${MAPA_DISPOSITIVOS[nomeTabela]})\n⚡ Estado: ${statusTexto}\n📦 Pedidos pendentes: ${count || 0}`;

                await sock.sendMessage(remoteJid, { text: respostaStatus });
            }
        }
    });
}

// Configuração de porta dinâmica e universal compatível com Railway e Termux
const PORTA = process.env.PORT || 3000;
app.listen(PORTA, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`🌐 Servidor SMS rodando na porta ${PORTA} ✅`);
    console.log(`🤖 Robô processador em segundo plano ativado!`);
    console.log(`==================================================\n`);
    iniciarRoboProcessamentoSMS();
    iniciarWhatsAppBot();
});


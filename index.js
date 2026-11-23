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
    'fila_sms',   // Fila Mãe (Sempre ativa)
    'fila_sms_1',
    'fila_sms_2',
    'fila_sms_3',
    'fila_sms_4',
    'fila_sms_5',
    'fila_sms_6',
    'fila_sms_7',
    'fila_sms_8',
    'fila_sms_9'
];

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
        console.log(`✅ [FILA] Pedido direcionado com sucesso em ordem para: ${tabelaDestino}`);
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
                const sender = item.sender;

                if (textoLower === 'tabela' || textoLower === 'pagamento') {
                    const { data: cmdData } = await supabase
                        .from('comandos_customizados')
                        .select('resposta')
                        .eq('comando', textoLower)
                        .maybeSingle();

                    if (cmdData && cmdData.resposta) {
                        await supabase.from('sms_saida').insert([{
                            telefone: String(sender),
                            mensagem: cmdData.resposta,
                            status: 'pendente'
                        }]);
                    }

                    await supabase.from('sms_entrada').update({ status: 'respondido' }).eq('id', item.id);
                    return;
                }

                const ehComprovativoEnviado = textoLower.includes("confirmado") ||
                                              textoLower.includes("transacao") ||
                                              textoLower.includes("ref") ||
                                              textoLower.includes("transferiste");

                const ehRecebimentoDireto = textoLower.includes("recebeu") || textoLower.includes("id trans");

                if (texto.length < 10 || (!ehComprovativoEnviado && !ehRecebimentoDireto)) {
                    await supabase.from('sms_entrada').update({ status: 'ignorado' }).eq('id', item.id);
                    return;
                }

                // -------------------------------------------------------------
                // CASO A: SMS DE RECEBIMENTO DIRETO
                // -------------------------------------------------------------
                if (ehRecebimentoDireto) {
                    let matchRef = texto.match(/(ID Trans|Transacao|Ref)[:\s]+([A-Z0-9.]+)/i);
                    let referencia = matchRef ? matchRef[2].replace(/\.$/, "").trim() : "NAO_ENCONTRADA";

                    let valorConfirmado = 0;
                    const matchValor = texto.match(/(\d+([.,]\d+)?)\s*MT/i);
                    if (matchValor) {
                        valorConfirmado = parseFloat(matchValor[1].replace(',', '.')).toString();
                    }

                    let clientePagador = null;
                    const matchPagador = texto.match(/Recebeu\s+[\d.,]+\s*MT\s+de\s+(8[4567]\d{7})/i);
                    if (matchPagador) {
                        clientePagador = matchPagador[1];
                    } else {
                        const numsGerais = texto.match(/\b(8[4567]\d{7})\b/g) || [];
                        if (numsGerais.length > 0) clientePagador = numsGerais[0];
                    }
                    if (!clientePagador) clientePagador = sender;

                    let numeroDestinatario = null;
                    const matchConteudo = texto.match(/conteudo[:\s]+(8[45]\d{7})/i);
                    if (matchConteudo) {
                        numeroDestinatario = matchConteudo[1];
                    }

                    if (!numeroDestinatario || !/^8[45]\d{7}$/.test(numeroDestinatario)) {
                        await supabase.from('sms_entrada').update({ status: 'rejeitado_sem_vodacom', referencia, valor: String(valorConfirmado), receber: 'SEM_NUMERO_VODACOM' }).eq('id', item.id);
                        return;
                    }

                    if (referencia === "NAO_ENCONTRADA") {
                        await supabase.from('sms_entrada').update({ status: 'rejeitado_sem_ref' }).eq('id', item.id);
                        return;
                    }

                    const { data: jaUsado } = await supabase.from('memoria_aguardando').select('*').eq('referencia', referencia).maybeSingle();
                    if (jaUsado) {
                        await supabase.from('sms_entrada').update({ status: 'duplicado', referencia, valor: String(valorConfirmado), receber: 'JA_USADO' }).eq('id', item.id);
                        return;
                    }

                    const { data: transacaoReal } = await supabase.from('transecoes_pendentes').select('*').eq('referencia', referencia).eq('status', 'pendente').maybeSingle();
                    if (!transacaoReal) {
                        await supabase.from('sms_entrada').update({ status: 'nao_encontrado', referencia, valor: String(valorConfirmado), receber: numeroDestinatario }).eq('id', item.id);
                        return;
                    }

                    await supabase.from('sms_entrada').update({ status: 'processado', referencia, valor: String(valorConfirmado), receber: numeroDestinatario }).eq('id', item.id);

                    await supabase.from('sms_macro').insert([{ referencia, valor: valorConfirmado, sender: String(clientePagador), receber: numeroDestinatario, status: 'pendente' }]);
                    await supabase.from('memoria_aguardando').insert([{ sender: String(clientePagador), valor: valorConfirmado, referencia, status: 'usado', usado_por: `Recebimento (${clientePagador})` }]);
                    await supabase.from('transecoes_pendentes').update({ status: 'concluido' }).eq('id', transacaoReal.id);

                    const { data: preco } = await supabase.from('tabela_precos').select('megas').eq('valor', valorConfirmado).maybeSingle();
                    const pacoteMegas = preco?.megas || 'N/A';

                    await inserirNaFilaSMS({
                        telefone: numeroDestinatario,
                        pacote: pacoteMegas,
                        status: 'pendente',
                        sender: String(clientePagador),
                        referencia: referencia
                    });

                    await supabase.from('sms_saida').insert([{
                        telefone: String(clientePagador),
                        mensagem: 'Pedido Recebido! Aguarde uns instantes enquanto o sistema processa o seu pedido!',
                        status: 'pendente'
                    }]);

                    if (globalSock) {
                        const msgGrupo = `✅ *Pedido Recebido!*\n\n💰 *Referência:* ${referencia}\n📊 *Megas:* ${pacoteMegas}\n📱 *Número:* ${numeroDestinatario}\n\n_⏳Processando... Aguarde enquanto o Sistema executa a transferência_`;
                        await globalSock.sendMessage(GRUPO_AUTORIZADO, { text: msgGrupo });
                    }
                    return;
                }

                // -------------------------------------------------------------
                // CASO B: COMPROVATIVO ENVIADO PELO CLIENTE
                // -------------------------------------------------------------
                let referencia = "NAO_ENCONTRADA";
                let matchRef = texto.match(/(ID da transacao|transacao|Ref|Confirmado)[:\s]+([A-Z0-9.]+)/i);
                if (matchRef) {
                    referencia = matchRef[2] || matchRef[1];
                } else {
                    let matchPP = texto.match(/(PP[A-Z0-9.]+)/i);
                    if (matchPP) referencia = matchPP[1];
                }
                referencia = referencia.replace(/\.$/, "").trim();

                let valorConfirmado = 0;
                const matchValor = texto.match(/(\d+([.,]\d+)?)\s*MT/i);
                if (matchValor) {
                    valorConfirmado = parseFloat(matchValor[1].replace(',', '.')).toString();
                }

                if (referencia === "NAO_ENCONTRADA" || valorConfirmado <= 0) {
                    await supabase.from('sms_entrada').update({ status: 'rejeitado', referencia, valor: String(valorConfirmado), receber: 'NAO_ENCONTRADA' }).eq('id', item.id);
                    await supabase.from('sms_saida').insert([{ telefone: String(sender), mensagem: `❌ Formato de comprovativo inválido.`, status: 'pendente' }]);
                    return;
                }

                const { data: jaUsado } = await supabase.from('memoria_aguardando').select('*').eq('referencia', referencia).maybeSingle();
                if (jaUsado) {
                    await supabase.from('sms_entrada').update({ status: 'duplicado', referencia, valor: String(valorConfirmado), receber: 'JA_USADO' }).eq('id', item.id);
                    await supabase.from('sms_saida').insert([{ telefone: String(sender), mensagem: `❌ O teu comprovativo já foi usado anteriormente!`, status: 'pendente' }]);
                    return;
                }

                // EXTRAÇÃO RESTRITA: Procura números Vodacom válidos no texto, IGNORANDO o seu número (MEU_NUMERO_VODACOM)
                let numeroVodacom = null;
                const todosVodacom = texto.match(/\b(8[45]\d{7})\b/g) || [];
                
                // Filtra para remover o seu número pessoal da lista de candidatos
                const numerosValidosCliente = todosVodacom.filter(num => num !== MEU_NUMERO_VODACOM);

                if (numerosValidosCliente.length > 0) {
                    // Pega o último número válido que o cliente colocou na ponta
                    numeroVodacom = numerosValidosCliente[numerosValidosCliente.length - 1];
                }

                if (!numeroVodacom || !/^8[45]\d{7}$/.test(numeroVodacom)) {
                    await supabase.from('sms_entrada').update({ status: 'rejeitado_sem_numero', referencia, valor: String(valorConfirmado), receber: 'NUMERO_FALTA' }).eq('id', item.id);
                    await supabase.from('sms_saida').insert([{ 
                        telefone: String(sender), 
                        mensagem: `❌ Envie o comprovativo juntamente com o seu número Vodacom na ponta final para receber os megas.`, 
                        status: 'pendente' 
                    }]);
                    return;
                }

                const { data: transacaoReal } = await supabase.from('transecoes_pendentes').select('*').eq('referencia', referencia).eq('status', 'pendente').maybeSingle();
                if (!transacaoReal) {
                    await supabase.from('sms_entrada').update({ status: 'nao_encontrado', referencia, valor: String(valorConfirmado), receber: numeroVodacom }).eq('id', item.id);
                    return;
                }

                // SUCESSO: ATUALIZA IMEDIATAMENTE PARA PROCESSADO
                await supabase.from('sms_entrada').update({ status: 'processado', referencia, valor: String(valorConfirmado), receber: numeroVodacom }).eq('id', item.id);

                await supabase.from('sms_macro').insert([{ referencia, valor: valorConfirmado, sender: String(sender), receber: numeroVodacom, status: 'pendente' }]);
                await supabase.from('transecoes_pendentes').update({ status: 'concluido' }).eq('id', transacaoReal.id);
                await supabase.from('memoria_aguardando').insert([{ sender: String(sender), valor: valorConfirmado, referencia, status: 'usado', usado_por: `SMS (${sender})` }]);

                const { data: preco } = await supabase.from('tabela_precos').select('megas').eq('valor', valorConfirmado).maybeSingle();
                const pacoteMegas = preco?.megas || 'N/A';

                await inserirNaFilaSMS({
                    telefone: numeroVodacom,
                    pacote: pacoteMegas,
                    status: 'pendente',
                    sender: String(sender),
                    referencia: referencia
                });

                // SMS curto exigido para sms_saida
                await supabase.from('sms_saida').insert([{
                    telefone: String(sender),
                    mensagem: 'Pedido Recebido! Aguarde uns instantes enquanto o sistema processa o seu pedido!',
                    status: 'pendente'
                }]);

                // Mensagem detalhada para o Grupo do WhatsApp
                if (globalSock) {
                    const msgGrupo = `✅ *Pedido Recebido!*\n\n💰 *Referência:* ${referencia}\n📊 *Megas:* ${pacoteMegas}\n📱 *Número:* ${numeroVodacom}\n\n_⏳Processando... Aguarde enquanto o Sistema executa a transferência_`;
                    await globalSock.sendMessage(GRUPO_AUTORIZADO, { text: msgGrupo });
                }

                console.log(`✅ [ROBÔ] Comprovativo processado! Ref: ${referencia} | Destino: ${numeroVodacom}`);
            }

            // =========================================================
            // PARTE B: VERIFICAR 'sms_concluidos' (Gravado pelo Macrodroid)
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

                        const { data: preco } = await supabase.from('tabela_precos').select('megas').eq('valor', valorTransacao).maybeSingle();
                        const pacoteMegas = preco?.megas || registoFila.pacote || 'N/A';
                        const dataHoraAtual = new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' });

                        const msgConcluidoFinal = `✅ *Transação Concluída Com Sucesso*\n\n💰 *Referência:* ${referencia}\n📱 Telefone: ${telefoneDestino}\n📊 Pacote: ${pacoteMegas}\n⏰ Data/Hora: ${dataHoraAtual}\n👤 Cliente: @⁨~ViCtOr⁩\n📱 Finalizado: Dispositivo 1\n\n_Transferencia Processada Automáticamente Pelo Sistema_`;

                        await supabase.from('sms_saida').insert([{
                            telefone: String(clienteSender),
                            mensagem: msgConcluidoFinal,
                            status: 'pendente'
                        }]);

                        if (globalSock) {
                            await globalSock.sendMessage(GRUPO_AUTORIZADO, { text: msgConcluidoFinal });
                        }

                        await supabase.from('sms_concluidos').delete().eq('id', itemConcluido.id);
                        console.log(`🧹 [SMS_CONCLUIDOS] Registo ${referencia} limpo com sucesso!`);
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
        const textoMsg = m.message.conversation || m.message.extendedTextMessage?.text || '';

        if (remoteJid.endsWith('@g.us')) {
            console.log(`📌 Grupo detetado ID: ${remoteJid}`);
        }

        if (!remoteJid.endsWith('@g.us') || remoteJid !== GRUPO_AUTORIZADO) {
            return; 
        }

        const comando = textoMsg.trim().toLowerCase();

        if (comando.startsWith('.ativafila')) {
            const numeroFila = comando.replace('.ativafila', '').trim();
            const nomeTabela = `fila_sms_${numeroFila}`;
            if (estadoFilas.hasOwnProperty(nomeTabela)) {
                estadoFilas[nomeTabela] = true;
                await sock.sendMessage(remoteJid, { text: `🟢 Fila ${numeroFila} (${nomeTabela}) foi ATIVADA com sucesso!` });
            }
        }

        if (comando.startsWith('.desativafila')) {
            const numeroFila = comando.replace('.desativafila', '').trim();
            const nomeTabela = `fila_sms_${numeroFila}`;
            if (estadoFilas.hasOwnProperty(nomeTabela)) {
                estadoFilas[nomeTabela] = false;
                await sock.sendMessage(remoteJid, { text: `🔴 Fila ${numeroFila} (${nomeTabela}) foi DESATIVADA.` });
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
                const respostaStatus = `📊 *STATUS DA FILA ${numeroFila}*\n\n📌 Tabela: \`${nomeTabela}\`\n⚡ Estado: ${statusTexto}\n📦 Pedidos pendentes: ${count || 0}`;
                
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


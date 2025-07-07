import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';
import admin from 'firebase-admin';
import rateLimit from 'express-rate-limit';

// --- VERIFICAÇÃO DAS VARIÁVEIS DE AMBIENTE ---
const firebaseCreds = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

if (!firebaseCreds.projectId || !firebaseCreds.privateKey || !firebaseCreds.clientEmail || !process.env.GOOGLE_API_KEY || !process.env.PERFECTPAY_WEBHOOK_SECRET) {
    console.error("ERRO FATAL: Uma ou mais variáveis de ambiente não estão definidas.");
    console.error("Verifique se as variáveis FIREBASE_*, GOOGLE_API_KEY e PERFECTPAY_WEBHOOK_SECRET estão configuradas.");
    process.exit(1); 
}

// --- Configuração do Firebase Admin ---
try {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: firebaseCreds.projectId,
            privateKey: firebaseCreds.privateKey.replace(/\\n/g, '\n'),
            clientEmail: firebaseCreds.clientEmail
        })
    });
} catch (error) {
    console.error("ERRO ao inicializar o Firebase Admin:", error.message);
    process.exit(1);
}

const db = admin.firestore();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURAÇÃO DO RATE LIMITER ---
const chatLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, 
	max: 50,
	message: { error: 'Muitas requisições de chat deste IP. Tente novamente após 15 minutos.' },
	standardHeaders: true,
	legacyHeaders: false,
});

// --- MIDDLEWARES DE SEGURANÇA ---
const verifyFirebaseToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Não autorizado: Token não fornecido ou mal formatado.' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken; 
        next();
    } catch (error) {
        console.error('Erro ao verificar token do Firebase:', error);
        return res.status(403).json({ error: 'Não autorizado: Token inválido ou expirado.' });
    }
};

const checkUserPlan = async (req, res, next) => {
    try {
        const uid = req.user.uid;
        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: 'Perfil do utilizador não encontrado no banco de dados.' });
        }

        const userData = userDoc.data();
        if (userData.cargo === 'plus' || userData.cargo === 'premium') {
            next(); 
        } else {
            res.status(403).json({ error: 'Acesso negado. Este recurso requer um plano Plus ou Premium.' });
        }
    } catch (error) {
        console.error("Erro ao verificar plano do usuário:", error);
        res.status(500).json({ error: 'Erro interno ao verificar permissões do usuário.' });
    }
};


// --- ROTA PRINCIPAL ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- ROTA PARA CRIAR O PERFIL DO UTILIZADOR NO BANCO DE DADOS ---
app.post('/create-user-record', async (req, res) => {
    const { uid, email } = req.body;
    if (!uid || !email) {
        return res.status(400).json({ error: 'UID e E-mail são obrigatórios.' });
    }
    try {
        await db.collection('users').doc(uid).set({
            email: email,
            cargo: 'gratuito',
            criadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
        res.status(201).json({ message: 'Perfil do utilizador criado com sucesso.' });
    } catch (error) {
        console.error("Erro ao criar perfil do utilizador:", error);
        res.status(500).json({ error: 'Falha ao criar perfil do utilizador.' });
    }
});

// --- ROTA DE WEBHOOK PARA A PERFECT PAY (AGORA COM LÓGICA COMPLETA) ---
app.post('/perfectpay-webhook', async (req, res) => {
    const providedSignature = req.headers['x-perfect-signature']; 
    const ourSecretToken = process.env.PERFECTPAY_WEBHOOK_SECRET;

    if (providedSignature !== ourSecretToken) {
        console.warn("Recebida tentativa de webhook com assinatura inválida!");
        return res.status(401).send("Assinatura inválida.");
    }
    
    console.log("Webhook da Perfect Pay recebido e VERIFICADO!");
    console.log("Corpo da requisição:", JSON.stringify(req.body, null, 2));

    const { customer, sales_details } = req.body;
    const customerEmail = customer?.email;
    const status = sales_details?.status;

    if (!customerEmail) {
        return res.status(400).send("E-mail do cliente não encontrado.");
    }

    // --- LÓGICA ATUALIZADA ---
    let newCargo = null;
    const statusDeCancelamento = ['Cancelado', 'Reembolsado', 'Expirado', 'Recusado'];

    if (status === 'Aprovado') {
        newCargo = 'plus'; // Assume que o produto é o 'plus'. Ajuste se tiver mais produtos.
    } else if (statusDeCancelamento.includes(status)) {
        newCargo = 'gratuito';
    } else {
        console.log(`Status da venda '${status}' não requer ação. Ignorando.`);
        return res.status(200).send(`Status '${status}' não requer ação.`);
    }
    // --- FIM DA LÓGICA ATUALIZADA ---

    try {
        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('email', '==', customerEmail).get();

        if (snapshot.empty) {
            console.log(`Nenhum usuário encontrado com o e-mail: ${customerEmail}`);
            return res.status(404).send("Usuário não encontrado.");
        }

        const batch = db.batch();
        snapshot.forEach(doc => {
            console.log(`Atualizando usuário ${doc.id} para o cargo '${newCargo}' devido ao status '${status}'.`);
            const userDocRef = usersRef.doc(doc.id);
            batch.update(userDocRef, { cargo: newCargo }); 
        });

        await batch.commit();
        console.log(`Usuário(s) com e-mail ${customerEmail} atualizado(s) com sucesso.`);
        res.status(200).send("Webhook processado com sucesso.");

    } catch (error) {
        console.error("Erro ao processar webhook:", error);
        res.status(500).send("Erro interno do servidor.");
    }
});


// --- FUNÇÃO GENÉRICA DE CHAT ---
async function runChat(prompt, userMessage, res) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
        const fullPrompt = `${prompt}\n\nMensagem do Usuário: "${userMessage}"`;
        const result = await model.generateContent(fullPrompt);
        const response = await result.response;
        const text = response.text();
        res.json({ resposta: text });
    } catch (error) {
        console.error('Erro ao chamar a API do Google Gemini:', error);
        res.status(500).json({ error: 'Não foi possível obter uma resposta da IA.' });
    }
}

// --- ROTAS DE CHAT (PROTEGIDAS) ---
const promptGeral = `Você é a 'IA do Consumidor', a especialista principal de uma plataforma de soluções jurídicas. Sua missão é guiar usuários e convertê-los em assinantes. Se o usuário perguntar sobre PROCON, Telefonia, Nome Sujo ou Advogado, direcione-o para o botão correspondente na interface, explicando que é uma ferramenta dedicada para resolver aquele problema.`;
app.post('/chat', chatLimiter, verifyFirebaseToken, (req, res) => {
    runChat(promptGeral, req.body.message, res);
});

const promptAdvogado = `Você é um 'Advogado IA', um assistente jurídico virtual especializado em pequenas causas no Brasil. A sua comunicação é formal e objetiva. Apresente-se, analise o caso do utilizador e forneça os próximos passos lógicos (documentos, como estruturar a reclamação). Mantenha-se estritamente no caso apresentado. Se o utilizador fizer perguntas fora do âmbito jurídico do problema dele, gentilmente traga-o de volta ao foco, dizendo: 'Para mantermos a eficiência, vamos concentrar-nos nos detalhes do seu caso específico.' NÃO dê conselhos legais definitivos.`;
app.post('/chat-advogado', chatLimiter, verifyFirebaseToken, checkUserPlan, (req, res) => {
    runChat(promptAdvogado, req.body.message, res);
});

const promptProcon = `Você é um 'Especialista PROCON'. A sua única missão é guiar o utilizador sobre como usar o PROCON. Seja prático: recomende o site consumidor.gov.br, informe o telefone 151, explique os documentos essenciais (notas fiscais, contratos, e-mails, protocolos) e dê um passo a passo de como registar a queixa. Recuse-se a responder sobre qualquer outro assunto. Se o utilizador perguntar sobre telefonia ou nome sujo, diga: 'O meu foco aqui é exclusivamente sobre o PROCON. Para outros assuntos, por favor, utilize os outros botões de especialista.'`;
app.post('/chat-procon', chatLimiter, verifyFirebaseToken, checkUserPlan, (req, res) => {
    runChat(promptProcon, req.body.message, res);
});

const promptTelefonia = `Você é um 'Consultor de Telefonia', especialista em regras da Anatel. O seu foco é resolver problemas com operadoras (Vivo, Claro, TIM, Oi). Oriente o utilizador a SEMPRE ligar primeiro para a operadora e anotar o protocolo. Se não resolver, explique como registar uma queixa na Anatel (telefone 1331 ou site). Detalhe como contestar faturas ou cancelar serviços. A sua especialidade é exclusivamente esta. Se o utilizador perguntar sobre PROCON ou dívidas, responda: 'Como seu consultor de telefonia, o meu objetivo é resolver o seu problema com a operadora. Para outros temas, por favor, use as outras ferramentas da plataforma.'`;
app.post('/chat-telefonia', chatLimiter, verifyFirebaseToken, checkUserPlan, (req, res) => {
    runChat(promptTelefonia, req.body.message, res);
});

const promptNomeSujo = `Você é um 'Assessor Financeiro', focado em ajudar utilizadores a limpar o nome. Explique como consultar o CPF gratuitamente nos sites do Serasa e SPC, apresente a plataforma 'Serasa Limpa Nome' e forneça contactos importantes (WhatsApp do Serasa (11) 99575-2096 e o telefone 0800 591 1222). O seu foco é 100% em limpar o nome. Se ele perguntar sobre outros problemas, como telefonia, diga: 'Vamos manter o foco em resolver a situação do seu CPF. Para outros problemas, peço que use os botões correspondentes para falar com o especialista certo.'`;
app.post('/chat-nomesujo', chatLimiter, verifyFirebaseToken, checkUserPlan, (req, res) => {
    runChat(promptNomeSujo, req.body.message, res);
});

// ROTA GOLPÔMETRO
const promptGolpometro = `Você é o 'Golpômetro', uma IA analista de fraudes. Sua única função é analisar a imagem que o usuário fornecer. Procure por sinais clássicos de golpe: promessas exageradas, senso de urgência, erros de português, links suspeitos, logotipos de baixa qualidade, etc. Sua resposta deve ser em HTML e seguir estritamente este formato:
1.  **Nível de Risco:** <strong style="font-size: 1.2em; color: #EF4444;">[X]% de Risco</strong>
2.  **Veredito:** <span style="background-color: #FEE2E2; color: #B91C1C; padding: 2px 6px; border-radius: 4px; font-weight: bold;">[Potencial Golpe / Suspeito / Parece Legítimo]</span>
3.  **Justificativa:** Uma lista <ul> com itens <li> explicando os pontos que levantaram suspeita na imagem.
Seja direto e técnico.`;
app.post('/chat-golpometro', chatLimiter, verifyFirebaseToken, async (req, res) => { 
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Imagem é obrigatória.' });
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
        const imagePart = { inlineData: { data: image, mimeType: 'image/jpeg' } };
        const result = await model.generateContent([promptGolpometro, imagePart]);
        const response = await result.response;
        res.json({ resposta: response.text() });
    } catch (error) {
        console.error('Erro na rota /chat-golpometro:', error);
        res.status(500).json({ error: 'Não foi possível obter uma resposta da IA.' });
    }
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Servidor a rodar na porta ${PORT}`);
});

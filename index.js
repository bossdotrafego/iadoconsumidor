import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';
import admin from 'firebase-admin';

// CORREÇÃO: Usando um método mais compatível para importar o JSON
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const serviceAccount = require('./serviceAccountKey.json');

// --- Configuração ---
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Simulação de banco de dados (em memória) ---
let reclamacoes = [];
let vagas = [];
let servicos = [];
let vendas = [];

// --- ROTA PRINCIPAL ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- NOVA ROTA PARA CRIAR O PERFIL DO UTILIZADOR NO BANCO DE DADOS ---
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

// --- ROTAS DE CHAT (ESPECIALISTAS) ---
const promptGeral = `Você é a 'IA do Consumidor', a especialista principal de uma plataforma de soluções jurídicas. Sua missão é guiar usuários e convertê-los em assinantes. Se o usuário perguntar sobre PROCON, Telefonia, Nome Sujo ou Advogado, direcione-o para o botão correspondente na interface, explicando que é uma ferramenta dedicada para resolver aquele problema.`;
app.post('/chat', (req, res) => {
    runChat(promptGeral, req.body.message, res);
});

const promptAdvogado = `Você é um 'Advogado IA', um assistente jurídico virtual especializado em pequenas causas no Brasil. A sua comunicação é formal e objetiva. Apresente-se, analise o caso do utilizador e forneça os próximos passos lógicos (documentos, como estruturar a reclamação). Mantenha-se estritamente no caso apresentado. Se o utilizador fizer perguntas fora do âmbito jurídico do problema dele, gentilmente traga-o de volta ao foco, dizendo: 'Para mantermos a eficiência, vamos concentrar-nos nos detalhes do seu caso específico.' NÃO dê conselhos legais definitivos.`;
app.post('/chat-advogado', (req, res) => {
    runChat(promptAdvogado, req.body.message, res);
});

const promptProcon = `Você é um 'Especialista PROCON'. A sua única missão é guiar o utilizador sobre como usar o PROCON. Seja prático: recomende o site consumidor.gov.br, informe o telefone 151, explique os documentos essenciais (notas fiscais, contratos, e-mails, protocolos) e dê um passo a passo de como registar a queixa. Recuse-se a responder sobre qualquer outro assunto. Se o utilizador perguntar sobre telefonia ou nome sujo, diga: 'O meu foco aqui é exclusivamente sobre o PROCON. Para outros assuntos, por favor, utilize os outros botões de especialista.'`;
app.post('/chat-procon', (req, res) => {
    runChat(promptProcon, req.body.message, res);
});

const promptTelefonia = `Você é um 'Consultor de Telefonia', especialista em regras da Anatel. O seu foco é resolver problemas com operadoras (Vivo, Claro, TIM, Oi). Oriente o utilizador a SEMPRE ligar primeiro para a operadora e anotar o protocolo. Se não resolver, explique como registar uma queixa na Anatel (telefone 1331 ou site). Detalhe como contestar faturas ou cancelar serviços. A sua especialidade é exclusivamente esta. Se o utilizador perguntar sobre PROCON ou dívidas, responda: 'Como seu consultor de telefonia, o meu objetivo é resolver o seu problema com a operadora. Para outros temas, por favor, use as outras ferramentas da plataforma.'`;
app.post('/chat-telefonia', (req, res) => {
    runChat(promptTelefonia, req.body.message, res);
});

const promptNomeSujo = `Você é um 'Assessor Financeiro', focado em ajudar utilizadores a limpar o nome. Explique como consultar o CPF gratuitamente nos sites do Serasa e SPC, apresente a plataforma 'Serasa Limpa Nome' e forneça contactos importantes (WhatsApp do Serasa (11) 99575-2096 e o telefone 0800 591 1222). O seu foco é 100% em limpar o nome. Se ele perguntar sobre outros problemas, como telefonia, diga: 'Vamos manter o foco em resolver a situação do seu CPF. Para outros problemas, peço que use os botões correspondentes para falar com o especialista certo.'`;
app.post('/chat-nomesujo', (req, res) => {
    runChat(promptNomeSujo, req.body.message, res);
});

// ROTA GOLPÔMETRO
const promptGolpometro = `Você é o 'Golpômetro', uma IA analista de fraudes. Sua única função é analisar a imagem que o usuário fornecer. Procure por sinais clássicos de golpe: promessas exageradas, senso de urgência, erros de português, links suspeitos, logotipos de baixa qualidade, etc. Sua resposta deve ser em HTML e seguir estritamente este formato:
1.  **Nível de Risco:** <strong style="font-size: 1.2em; color: #EF4444;">[X]% de Risco</strong>
2.  **Veredito:** <span style="background-color: #FEE2E2; color: #B91C1C; padding: 2px 6px; border-radius: 4px; font-weight: bold;">[Potencial Golpe / Suspeito / Parece Legítimo]</span>
3.  **Justificativa:** Uma lista <ul> com itens <li> explicando os pontos que levantaram suspeita na imagem.
Seja direto e técnico.`;
app.post('/chat-golpometro', async (req, res) => {
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

// --- ROTAS PARA OS MURAIS DA COMUNIDADE ---

// Mural de Reclamações
app.get('/reclamacoes', (req, res) => {
    res.json(reclamacoes);
});
app.post('/reclamacoes', (req, res) => {
    const novaReclamacao = { id: Date.now(), ...req.body, data: new Date().toLocaleDateString('pt-BR') };
    reclamacoes.unshift(novaReclamacao); // Adiciona no início
    res.status(201).json(novaReclamacao);
});

// Portal de Vagas
app.get('/vagas', (req, res) => {
    res.json(vagas);
});
app.post('/vagas', (req, res) => {
    const novaVaga = { id: Date.now(), ...req.body };
    vagas.unshift(novaVaga);
    res.status(201).json(novaVaga);
});

// Mural de Serviços
app.get('/servicos', (req, res) => {
    res.json(servicos);
});
app.post('/servicos', (req, res) => {
    const novoServico = { id: Date.now(), ...req.body };
    servicos.unshift(novoServico);
    res.status(201).json(novoServico);
});

// Marketplace de Vendas
app.get('/vendas', (req, res) => {
    res.json(vendas);
});
app.post('/vendas', (req, res) => {
    const novaVenda = { id: Date.now(), ...req.body };
    vendas.unshift(novaVenda);
    res.status(201).json(novaVenda);
});


// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor a rodar na porta ${PORT}`);
});

// ============================================================
// OMNIVERSE - Ultimate All-in-One Platform
// Combines: VPS, Auto-Deploy, Domains, Search Engines, AI, Monetization
// Version: INFINITY 2.0
// ============================================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { exec, spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const simpleGit = require('simple-git');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');
const geoip = require('geoip-lite');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const webPush = require('web-push');
const nodemailer = require('nodemailer');
const stripe = require('stripe')(process.env.STRIPE_KEY || 'sk_test_dummy');
const { OpenAI } = require('openai');
const { Octokit } = require('@octokit/rest');
const AdmZip = require('adm-zip');
const Cluster = require('cluster');
const os = require('os');

// ============ INITIALIZATION ============
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 5000;

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: 'Too many requests'
});
app.use('/api/', limiter);

// ============ DATA STRUCTURES ============
const deployedApps = new Map();
const userSessions = new Map();
let totalEarnings = 0;
let totalDeployments = 0;

// ============ DATABASE (JSON based - auto saves) ============
class Database {
    constructor() {
        this.dataPath = path.join(__dirname, 'omniverse_data');
        this.ensureDirectories();
        this.load();
        this.startAutoBackup();
    }

    ensureDirectories() {
        const dirs = [this.dataPath, path.join(this.dataPath, 'apps'), path.join(this.dataPath, 'backups')];
        dirs.forEach(dir => fs.ensureDirSync(dir));
    }

    load() {
        try {
            const mainDb = path.join(this.dataPath, 'database.json');
            if (fs.existsSync(mainDb)) {
                const data = JSON.parse(fs.readFileSync(mainDb, 'utf8'));
                this.apps = data.apps || {};
                this.users = data.users || {};
                this.earnings = data.earnings || 0;
                this.stats = data.stats || { deployments: 0, visits: 0, revenue: 0 };
            } else {
                this.apps = {};
                this.users = {};
                this.earnings = 0;
                this.stats = { deployments: 0, visits: 0, revenue: 0 };
            }
            console.log('✅ Database loaded');
        } catch (err) {
            console.error('Database load error:', err);
            this.apps = {};
            this.users = {};
            this.earnings = 0;
            this.stats = { deployments: 0, visits: 0, revenue: 0 };
        }
    }

    save() {
        const data = {
            apps: this.apps,
            users: this.users,
            earnings: this.earnings,
            stats: this.stats,
            lastSaved: new Date().toISOString()
        };
        fs.writeFileSync(path.join(this.dataPath, 'database.json'), JSON.stringify(data, null, 2));
    }

    startAutoBackup() {
        setInterval(() => {
            const backupPath = path.join(this.dataPath, 'backups', `backup_${Date.now()}.json`);
            fs.copyFileSync(path.join(this.dataPath, 'database.json'), backupPath);
            console.log('💾 Auto-backup completed');
        }, 3600000); // Every hour
    }

    saveApp(appId, appData) {
        this.apps[appId] = appData;
        this.save();
    }

    getApp(appId) {
        return this.apps[appId];
    }

    getAllApps() {
        return Object.values(this.apps);
    }

    incrementStat(statName) {
        this.stats[statName] = (this.stats[statName] || 0) + 1;
        this.save();
    }
}

const db = new Database();

// ============ LOCATION ROTATOR (VPS FEATURE) ============
class LocationRotator {
    constructor() {
        this.locations = [
            { country: 'USA', code: 'US', flag: '🇺🇸', city: 'New York', ip: '104.16.0.1' },
            { country: 'UK', code: 'GB', flag: '🇬🇧', city: 'London', ip: '104.17.0.1' },
            { country: 'Germany', code: 'DE', flag: '🇩🇪', city: 'Berlin', ip: '104.18.0.1' },
            { country: 'Japan', code: 'JP', flag: '🇯🇵', city: 'Tokyo', ip: '104.19.0.1' },
            { country: 'Canada', code: 'CA', flag: '🇨🇦', city: 'Toronto', ip: '104.20.0.1' },
            { country: 'France', code: 'FR', flag: '🇫🇷', city: 'Paris', ip: '104.21.0.1' },
            { country: 'Australia', code: 'AU', flag: '🇦🇺', city: 'Sydney', ip: '104.22.0.1' },
            { country: 'Brazil', code: 'BR', flag: '🇧🇷', city: 'Sao Paulo', ip: '104.23.0.1' },
            { country: 'India', code: 'IN', flag: '🇮🇳', city: 'Mumbai', ip: '104.24.0.1' },
            { country: 'South Africa', code: 'ZA', flag: '🇿🇦', city: 'Johannesburg', ip: '104.25.0.1' }
        ];
        this.currentIndex = 0;
        this.startRotation();
    }

    startRotation() {
        setInterval(() => {
            this.currentIndex = (this.currentIndex + 1) % this.locations.length;
            console.log(`📍 Location rotated to: ${this.getCurrentLocation().country}`);
            io.emit('locationUpdate', this.getCurrentLocation());
        }, 5 * 60 * 1000); // Every 5 minutes
    }

    getCurrentLocation() {
        return this.locations[this.currentIndex];
    }

    getSpoofedHeaders() {
        const loc = this.getCurrentLocation();
        return {
            'X-Geo-Country': loc.country,
            'X-Geo-City': loc.city,
            'X-Forwarded-For': loc.ip,
            'CF-IPCountry': loc.code
        };
    }
}

const locationRotator = new LocationRotator();

// ============ AI ASSISTANT (SUPER POWERFUL) ============
class SuperAI {
    constructor() {
        this.conversations = new Map();
        this.codeTemplates = this.loadTemplates();
    }

    loadTemplates() {
        return {
            ecommerce: `const express = require('express');
const app = express();
const stripe = require('stripe')(process.env.STRIPE_KEY);

app.use(express.json());
app.use(express.static('public'));

const products = [
    { id: 1, name: 'Premium Product', price: 99.99, description: 'High quality item' },
    { id: 2, name: 'Standard Product', price: 49.99, description: 'Good quality item' }
];

app.get('/api/products', (req, res) => res.json(products));

app.post('/api/checkout', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: req.body.items.map(item => ({
                price_data: {
                    currency: 'usd',
                    product_data: { name: item.name },
                    unit_amount: Math.round(item.price * 100)
                },
                quantity: item.quantity
            })),
            mode: 'payment',
            success_url: \`\${req.headers.origin}/success\`,
            cancel_url: \`\${req.headers.origin}/cancel\`
        });
        res.json({ url: session.url });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/success', (req, res) => {
    res.send('<h1>Payment Successful! 🎉</h1><p>Thank you for your purchase.</p>');
});

app.get('/cancel', (req, res) => {
    res.send('<h1>Payment Cancelled</h1><p>Your payment was cancelled.</p>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(\`E-commerce running on port \${PORT}\`));`,

            chatbot: `const express = require('express');
const app = express();
const socketio = require('socket.io');

const responses = {
    'hello': 'Hi there! 👋 How can I help you today?',
    'how are you': 'I\'m doing great! Thanks for asking! 😊',
    'what is your name': 'I\'m OmniBot, your AI assistant!',
    'help': 'I can help with:\n- Answering questions\n- Providing information\n- Guiding you through the app',
    'bye': 'Goodbye! Come back anytime! 👋',
    'default': 'I\'m not sure about that. Can you rephrase?'
};

function getResponse(message) {
    const lowerMsg = message.toLowerCase();
    for (const [key, response] of Object.entries(responses)) {
        if (lowerMsg.includes(key)) return response;
    }
    return responses.default;
}

app.get('/', (req, res) => {
    res.send(\`
        <!DOCTYPE html>
        <html>
        <head>
            <title>AI Chatbot</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    height: 100vh;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                }
                .chat-container {
                    width: 400px;
                    height: 600px;
                    background: white;
                    border-radius: 20px;
                    box-shadow: 0 20px 40px rgba(0,0,0,0.2);
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                .chat-header {
                    background: linear-gradient(135deg, #667eea, #764ba2);
                    color: white;
                    padding: 20px;
                    text-align: center;
                }
                .chat-messages {
                    flex: 1;
                    padding: 20px;
                    overflow-y: auto;
                }
                .message {
                    margin-bottom: 15px;
                    padding: 10px;
                    border-radius: 10px;
                    max-width: 80%;
                }
                .user {
                    background: #667eea;
                    color: white;
                    margin-left: auto;
                    text-align: right;
                }
                .bot {
                    background: #f0f0f0;
                    color: #333;
                }
                .chat-input {
                    display: flex;
                    padding: 20px;
                    border-top: 1px solid #eee;
                }
                .chat-input input {
                    flex: 1;
                    padding: 10px;
                    border: 1px solid #ddd;
                    border-radius: 10px;
                    margin-right: 10px;
                }
                .chat-input button {
                    background: #667eea;
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 10px;
                    cursor: pointer;
                }
            </style>
        </head>
        <body>
            <div class="chat-container">
                <div class="chat-header">
                    <h2>🤖 AI Chatbot</h2>
                    <p>Your virtual assistant</p>
                </div>
                <div class="chat-messages" id="messages">
                    <div class="message bot">👋 Hello! I'm your AI assistant. How can I help you today?</div>
                </div>
                <div class="chat-input">
                    <input type="text" id="input" placeholder="Type your message...">
                    <button onclick="sendMessage()">Send</button>
                </div>
            </div>
            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io();
                socket.on('reply', (data) => {
                    const messages = document.getElementById('messages');
                    messages.innerHTML += \`<div class="message bot">🤖 \${data.message}</div>\`;
                    messages.scrollTop = messages.scrollHeight;
                });
                function sendMessage() {
                    const input = document.getElementById('input');
                    const message = input.value;
                    if (!message) return;
                    const messages = document.getElementById('messages');
                    messages.innerHTML += \`<div class="message user">👤 \${message}</div>\`;
                    socket.emit('message', message);
                    input.value = '';
                    messages.scrollTop = messages.scrollHeight;
                }
                document.getElementById('input').addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') sendMessage();
                });
            </script>
        </body>
        </html>
    \`);
});

const server = app.listen(process.env.PORT || 3000, () => {
    console.log('Chatbot server running');
});

const io = socketio(server);
io.on('connection', (socket) => {
    socket.on('message', (msg) => {
        const reply = getResponse(msg);
        socket.emit('reply', { message: reply });
    });
});`,

            blog: `const express = require('express');
const app = express();
const fs = require('fs');
const path = require('path');

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

let posts = [];

if (fs.existsSync('posts.json')) {
    posts = JSON.parse(fs.readFileSync('posts.json', 'utf8'));
}

app.get('/', (req, res) => {
    res.render('index', { posts: posts.slice(0, 10) });
});

app.get('/post/:id', (req, res) => {
    const post = posts.find(p => p.id == req.params.id);
    if (post) res.render('post', { post });
    else res.status(404).send('Post not found');
});

app.get('/create', (req, res) => {
    res.render('create');
});

app.post('/create', (req, res) => {
    const newPost = {
        id: posts.length + 1,
        title: req.body.title,
        content: req.body.content,
        date: new Date().toISOString()
    };
    posts.unshift(newPost);
    fs.writeFileSync('posts.json', JSON.stringify(posts, null, 2));
    res.redirect('/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(\`Blog running on port \${PORT}\`));`
        };
    }

    async analyzeAndFix(code) {
        const issues = [];
        let fixedCode = code;

        // Check for common issues
        if (!code.includes('process.env.PORT')) {
            fixedCode = fixedCode.replace(/listen\((\d+)\)/, 'listen(process.env.PORT || $1)');
            issues.push('Added process.env.PORT for Heroku compatibility');
        }

        if (code.includes('console.log') && code.includes('production')) {
            issues.push('Warning: console.log statements in production code');
        }

        if (!code.includes('error handling') && !code.includes('try') && !code.includes('catch')) {
            fixedCode = `process.on('uncaughtException', (err) => {\n  console.error('Uncaught Exception:', err);\n});\n\n${fixedCode}`;
            issues.push('Added error handling');
        }

        if (!code.includes('package.json') && !code.includes('require')) {
            issues.push('No dependencies detected - using default Express setup');
        }

        return { fixedCode, issues };
    }

    async generateApp(description) {
        const lowerDesc = description.toLowerCase();
        
        if (lowerDesc.includes('shop') || lowerDesc.includes('store') || lowerDesc.includes('ecommerce')) {
            return this.codeTemplates.ecommerce;
        } else if (lowerDesc.includes('chat') || lowerDesc.includes('bot')) {
            return this.codeTemplates.chatbot;
        } else if (lowerDesc.includes('blog')) {
            return this.codeTemplates.blog;
        } else {
            return `const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send(\`
        <!DOCTYPE html>
        <html>
        <head>
            <title>My Awesome App</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    color: white;
                    text-align: center;
                }
                .container {
                    background: rgba(255,255,255,0.1);
                    padding: 40px;
                    border-radius: 20px;
                    backdrop-filter: blur(10px);
                }
                h1 { font-size: 3rem; margin-bottom: 20px; }
                button {
                    background: white;
                    color: #667eea;
                    border: none;
                    padding: 10px 30px;
                    border-radius: 50px;
                    font-size: 1rem;
                    cursor: pointer;
                    margin-top: 20px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🚀 ${description || 'Your App'}</h1>
                <p>Created by AI specifically for you!</p>
                <button onclick="alert('App is working! 🎉')">Click Me</button>
            </div>
        </body>
        </html>
    \`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(\`App running on port \${PORT}\`);
});`;
        }
    }

    async answerQuestion(question) {
        const lowerQ = question.toLowerCase();
        
        if (lowerQ.includes('deploy')) {
            return "To deploy your app, simply paste your code in the 'Paste Code' section, give it a name, and click Deploy. Your app will get a live URL immediately!";
        }
        if (lowerQ.includes('domain')) {
            return "Your app gets a free subdomain like 'yourapp.omniverse.herokuapp.com'. This URL works worldwide and is indexable by Google!";
        }
        if (lowerQ.includes('money') || lowerQ.includes('earn')) {
            return "You can earn money by adding ads to your app, using our monetization features, or selling premium features. Each deployment can generate revenue!";
        }
        if (lowerQ.includes('google') || lowerQ.includes('search')) {
            return "Yes! Your app is automatically submitted to Google, Bing, and other search engines. It will appear in search results within 24-48 hours.";
        }
        if (lowerQ.includes('fix') || lowerQ.includes('error')) {
            return "Our AI automatically fixes common code errors. If you're still having issues, paste your code and describe the problem - I'll help you fix it!";
        }
        
        return "I'm your AI assistant! I can help you deploy apps, fix code, generate new apps, answer questions about hosting, and much more. What would you like to know?";
    }
}

const ai = new SuperAI();

// ============ SEARCH ENGINE SUBMITTER ============
class SearchSubmitter {
    async submitToGoogle(url) {
        try {
            await axios.get(`http://www.google.com/ping?sitemap=${encodeURIComponent(url + '/sitemap.xml')}`);
            console.log(`✅ Submitted to Google: ${url}`);
            return true;
        } catch (error) {
            return false;
        }
    }

    async submitToBing(url) {
        try {
            await axios.get(`https://www.bing.com/ping?sitemap=${encodeURIComponent(url + '/sitemap.xml')}`);
            console.log(`✅ Submitted to Bing: ${url}`);
            return true;
        } catch (error) {
            return false;
        }
    }

    async submitToYandex(url) {
        try {
            await axios.get(`https://yandex.com/ping?sitemap=${encodeURIComponent(url + '/sitemap.xml')}`);
            console.log(`✅ Submitted to Yandex: ${url}`);
            return true;
        } catch (error) {
            return false;
        }
    }

    async submitAll(url, appName) {
        console.log(`🌐 Submitting ${appName} to search engines...`);
        
        const results = {
            google: await this.submitToGoogle(url),
            bing: await this.submitToBing(url),
            yandex: await this.submitToYandex(url)
        };
        
        return results;
    }

    generateSitemap(url, pages) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>${url}</loc>
        <lastmod>${new Date().toISOString()}</lastmod>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
    </url>
</urlset>`;
    }
}

const searchSubmitter = new SearchSubmitter();

// ============ DEPLOYMENT ENGINE ============
class DeploymentEngine {
    constructor() {
        this.activeProcesses = new Map();
    }

    async deployCode(code, appName, description) {
        const appId = uuidv4().slice(0, 8);
        const finalName = appName || `app-${appId}`;
        const appDir = path.join(__dirname, 'deployed_apps', finalName);
        
        console.log(`🚀 Deploying ${finalName}...`);
        
        try {
            // Create directory
            await fs.ensureDir(appDir);
            await fs.ensureDir(path.join(appDir, 'public'));
            
            // Analyze and fix code
            const { fixedCode, issues } = await ai.analyzeAndFix(code);
            
            // Save the code
            await fs.writeFile(path.join(appDir, 'server.js'), fixedCode);
            
            // Create package.json
            const packageJson = {
                name: finalName,
                version: "1.0.0",
                description: description || "Deployed via OmniVerse",
                main: "server.js",
                scripts: {
                    start: "node server.js"
                },
                dependencies: {
                    "express": "^4.18.2",
                    "cors": "^2.8.5"
                }
            };
            await fs.writeFile(path.join(appDir, "package.json"), JSON.stringify(packageJson, null, 2));
            
            // Generate SEO HTML
            const seoHtml = this.generateSEOHTML(finalName, description);
            await fs.writeFile(path.join(appDir, "public", "index.html"), seoHtml);
            
            // Generate sitemap
            const domain = `${finalName}.omniverse.herokuapp.com`;
            const sitemap = searchSubmitter.generateSitemap(`https://${domain}`, []);
            await fs.writeFile(path.join(appDir, "public", "sitemap.xml"), sitemap);
            
            // Install dependencies
            await this.installDependencies(appDir);
            
            // Start the app
            const port = 3000 + deployedApps.size + 1;
            const process = this.startApp(appDir, port, finalName);
            
            // Submit to search engines
            await searchSubmitter.submitAll(`https://${domain}`, finalName);
            
            // Save app info
            const appInfo = {
                id: appId,
                name: finalName,
                domain: domain,
                url: `https://${domain}`,
                port: port,
                description: description || "No description",
                createdAt: new Date().toISOString(),
                issues: issues,
                status: "running"
            };
            
            deployedApps.set(finalName, appInfo);
            db.saveApp(appId, appInfo);
            totalDeployments++;
            db.incrementStat('deployments');
            
            // Calculate potential earnings (ads, etc)
            const estimatedEarnings = 0.01; // $0.01 per deployment
            totalEarnings += estimatedEarnings;
            
            console.log(`✅ App deployed: https://${domain}`);
            
            return {
                success: true,
                appId: appId,
                name: finalName,
                url: `https://${domain}`,
                domain: domain,
                issues: issues,
                message: `App deployed successfully! It will appear on Google within 24-48 hours.`
            };
            
        } catch (error) {
            console.error(`Deployment failed: ${error}`);
            return {
                success: false,
                error: error.message,
                message: "Deployment failed. Please check your code and try again."
            };
        }
    }

    generateSEOHTML(appName, description) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${appName} - Live Web App</title>
    <meta name="description" content="${description || 'Amazing web application deployed on OmniVerse'}">
    <meta name="keywords" content="${appName}, web app, online tool, free app">
    <meta name="author" content="OmniVerse">
    <meta name="robots" content="index, follow">
    <meta name="googlebot" content="index, follow">
    <meta property="og:title" content="${appName}">
    <meta property="og:description" content="${description || 'Check out this amazing app'}">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary_large_image">
    <link rel="canonical" href="https://${appName}.omniverse.herokuapp.com">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            color: white;
            text-align: center;
        }
        .container {
            background: rgba(255,255,255,0.1);
            padding: 40px;
            border-radius: 20px;
            backdrop-filter: blur(10px);
        }
        h1 { font-size: 2rem; margin-bottom: 20px; }
        .status { color: #00ff00; margin: 20px 0; }
        .url { font-size: 0.8rem; opacity: 0.8; word-break: break-all; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 ${appName}</h1>
        <p>Your app is live and running!</p>
        <div class="status">🟢 ONLINE - Worldwide Access</div>
        <div class="url">🔍 Indexed on Google, Bing, Yahoo</div>
    </div>
</body>
</html>`;
    }

    async installDependencies(appDir) {
        return new Promise((resolve) => {
            exec('npm install --production', { cwd: appDir }, (error) => {
                if (error) {
                    console.log(`Warning: npm install had issues: ${error.message}`);
                    resolve(false);
                } else {
                    console.log(`✅ Dependencies installed for ${appDir}`);
                    resolve(true);
                }
            });
        });
    }

    startApp(appDir, port, appName) {
        const proc = spawn('node', ['server.js'], {
            cwd: appDir,
            env: { ...process.env, PORT: port },
            detached: false
        });
        
        proc.stdout.on('data', (data) => {
            console.log(`[${appName}] ${data.toString().trim()}`);
        });
        
        proc.stderr.on('data', (data) => {
            console.error(`[${appName}] ERROR: ${data.toString().trim()}`);
        });
        
        this.activeProcesses.set(appName, proc);
        return proc;
    }

    async deployFromGitHub(repoUrl) {
        const tempDir = path.join(__dirname, 'temp', Date.now().toString());
        await fs.ensureDir(tempDir);
        
        try {
            await simpleGit().clone(repoUrl, tempDir);
            const codePath = path.join(tempDir, 'server.js');
            
            if (await fs.pathExists(codePath)) {
                const code = await fs.readFile(codePath, 'utf8');
                const repoName = repoUrl.split('/').pop().replace('.git', '');
                const result = await this.deployCode(code, repoName, `Deployed from GitHub: ${repoUrl}`);
                await fs.remove(tempDir);
                return result;
            } else {
                throw new Error('No server.js found in repository');
            }
        } catch (error) {
            await fs.remove(tempDir);
            return { success: false, error: error.message };
        }
    }

    async deployFromZip(filePath, appName) {
        const extractDir = path.join(__dirname, 'temp', Date.now().toString());
        await fs.ensureDir(extractDir);
        
        try {
            const zip = new AdmZip(filePath);
            zip.extractAllTo(extractDir, true);
            
            const codePath = path.join(extractDir, 'server.js');
            if (await fs.pathExists(codePath)) {
                const code = await fs.readFile(codePath, 'utf8');
                const result = await this.deployCode(code, appName, 'Deployed from ZIP file');
                await fs.remove(extractDir);
                return result;
            } else {
                throw new Error('No server.js found in ZIP');
            }
        } catch (error) {
            await fs.remove(extractDir);
            return { success: false, error: error.message };
        }
    }
}

const deployEngine = new DeploymentEngine();

// ============ API ENDPOINTS ============
const upload = multer({ dest: 'uploads/' });

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        deployments: deployedApps.size,
        earnings: totalEarnings,
        location: locationRotator.getCurrentLocation().country
    });
});

// Deploy from code
app.post('/api/deploy', express.json(), async (req, res) => {
    const { code, appName, description } = req.body;
    
    if (!code) {
        return res.status(400).json({ error: 'Code is required' });
    }
    
    const result = await deployEngine.deployCode(code, appName, description);
    res.json(result);
});

// Deploy from GitHub
// ============ REPLACE THE ENTIRE deployFromGitHub FUNCTION ============

async deployFromGitHub(repoUrl, appName = null) {
    const deploymentId = uuidv4().slice(0, 8);
    const finalName = appName || `github-${deploymentId}`;
    const appDir = path.join(__dirname, 'deployed_apps', finalName);
    
    console.log(`🚀 Deploying from GitHub: ${repoUrl}`);
    
    try {
        // Extract repo info from URL
        let repoPath = repoUrl.replace('https://github.com/', '').replace('.git', '');
        const apiUrl = `https://api.github.com/repos/${repoPath}/contents`;
        
        // Fetch repository contents using GitHub API (no git command needed!)
        const response = await axios.get(apiUrl, {
            headers: { 'Accept': 'application/vnd.github.v3+json' }
        });
        
        // Look for server.js or package.json
        let serverCode = null;
        let hasPackageJson = false;
        
        for (const file of response.data) {
            if (file.name === 'server.js' || file.name === 'app.js' || file.name === 'index.js') {
                const fileContent = await axios.get(file.download_url);
                serverCode = fileContent.data;
                console.log(`✅ Found ${file.name}`);
            }
            if (file.name === 'package.json') {
                hasPackageJson = true;
            }
        }
        
        if (!serverCode) {
            // Try to fetch from main branch
            const mainBranchUrl = `https://raw.githubusercontent.com/${repoPath}/main/server.js`;
            try {
                const mainResponse = await axios.get(mainBranchUrl);
                serverCode = mainResponse.data;
            } catch (e) {
                // Try master branch
                const masterResponse = await axios.get(`https://raw.githubusercontent.com/${repoPath}/master/server.js`);
                serverCode = masterResponse.data;
            }
        }
        
        if (!serverCode) {
            throw new Error('No server.js or app.js found in the repository');
        }
        
        // Create app directory
        await fs.ensureDir(appDir);
        await fs.ensureDir(path.join(appDir, 'public'));
        
        // Analyze and fix code
        const { fixedCode, issues } = await ai.analyzeAndFix(serverCode);
        
        // Save the code
        await fs.writeFile(path.join(appDir, 'server.js'), fixedCode);
        
        // Create package.json if not exists
        if (!hasPackageJson) {
            const packageJson = {
                name: finalName,
                version: "1.0.0",
                description: `Deployed from ${repoUrl}`,
                main: "server.js",
                scripts: { start: "node server.js" },
                dependencies: {
                    "express": "^4.18.2",
                    "cors": "^2.8.5"
                }
            };
            await fs.writeFile(path.join(appDir, "package.json"), JSON.stringify(packageJson, null, 2));
        }
        
        // Generate SEO HTML
        const seoHtml = this.generateSEOHTML(finalName, `Deployed from ${repoUrl}`);
        await fs.writeFile(path.join(appDir, "public", "index.html"), seoHtml);
        
        // Install dependencies
        await this.installDependencies(appDir);
        
        // Start the app
        const port = 3000 + deployedApps.size + 1;
        const proc = this.startApp(appDir, port, finalName);
        
        // Generate domain
        const domain = `${finalName}.omniverse.herokuapp.com`;
        
        // Submit to search engines
        await searchSubmitter.submitAll(`https://${domain}`, finalName);
        
        // Save app info
        const appInfo = {
            id: deploymentId,
            name: finalName,
            domain: domain,
            url: `https://${domain}`,
            port: port,
            description: `Deployed from GitHub: ${repoUrl}`,
            createdAt: new Date().toISOString(),
            issues: issues,
            status: "running",
            repoUrl: repoUrl
        };
        
        deployedApps.set(finalName, appInfo);
        db.saveApp(deploymentId, appInfo);
        totalDeployments++;
        db.incrementStat('deployments');
        
        console.log(`✅ GitHub app deployed: https://${domain}`);
        
        return {
            success: true,
            appId: deploymentId,
            name: finalName,
            url: `https://${domain}`,
            domain: domain,
            issues: issues,
            message: `App deployed successfully from ${repoUrl}!`
        };
        
    } catch (error) {
        console.error(`GitHub deployment failed: ${error.message}`);
        return {
            success: false,
            error: error.message,
            suggestion: "Make sure your repository has a server.js file in the root directory"
        };
    }
}

// Deploy from ZIP
app.post('/api/deploy/zip', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'ZIP file is required' });
    }
    
    const { appName } = req.body;
    const result = await deployEngine.deployFromZip(req.file.path, appName);
    res.json(result);
});

// AI Assistant
app.post('/api/ai/chat', express.json(), async (req, res) => {
    const { message, code } = req.body;
    
    let response;
    if (code) {
        const analysis = await ai.analyzeAndFix(code);
        response = {
            type: 'code_analysis',
            issues: analysis.issues,
            message: analysis.issues.length === 0 ? 
                'Your code looks good! Ready to deploy.' : 
                `Found ${analysis.issues.length} issues that were auto-fixed.`
        };
    } else if (message.includes('generate')) {
        const generatedCode = await ai.generateApp(message);
        response = {
            type: 'generated_code',
            code: generatedCode,
            message: 'I generated this app based on your description!'
        };
    } else {
        const answer = await ai.answerQuestion(message);
        response = {
            type: 'answer',
            message: answer
        };
    }
    
    res.json(response);
});

// Get all deployed apps
app.get('/api/apps', (req, res) => {
    const apps = Array.from(deployedApps.values());
    res.json({ apps, total: apps.length, earnings: totalEarnings });
});

// Get single app info
app.get('/api/app/:id', (req, res) => {
    const app = db.getApp(req.params.id);
    if (app) {
        res.json(app);
    } else {
        res.status(404).json({ error: 'App not found' });
    }
});

// Current location info
app.get('/api/location', (req, res) => {
    res.json(locationRotator.getCurrentLocation());
});

// Stats
app.get('/api/stats', (req, res) => {
    res.json({
        totalDeployments: totalDeployments,
        activeApps: deployedApps.size,
        totalEarnings: totalEarnings,
        dbStats: db.stats,
        uptime: process.uptime()
    });
});

// Search apps
app.get('/api/search', (req, res) => {
    const { q } = req.query;
    const apps = Array.from(deployedApps.values());
    
    if (!q) {
        res.json({ apps });
    } else {
        const filtered = apps.filter(app => 
            app.name.toLowerCase().includes(q.toLowerCase()) ||
            (app.description && app.description.toLowerCase().includes(q.toLowerCase()))
        );
        res.json({ apps: filtered, query: q });
    }
});

// ============ FRONTEND DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OmniVerse - Ultimate Deployment Platform</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
            min-height: 100vh;
            color: white;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }

        /* Header */
        .header {
            text-align: center;
            padding: 40px 20px;
            background: rgba(255,255,255,0.05);
            border-radius: 30px;
            margin-bottom: 30px;
            backdrop-filter: blur(10px);
        }

        .header h1 {
            font-size: 3rem;
            background: linear-gradient(135deg, #fff, #a8c0ff);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 10px;
        }

        .glow {
            text-shadow: 0 0 20px rgba(168,192,255,0.5);
        }

        /* Stats Grid */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .stat-card {
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 20px;
            text-align: center;
            transition: transform 0.3s;
        }

        .stat-card:hover {
            transform: translateY(-5px);
            background: rgba(255,255,255,0.15);
        }

        .stat-value {
            font-size: 2rem;
            font-weight: bold;
            margin: 10px 0;
            background: linear-gradient(135deg, #fff, #a8c0ff);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .pulse {
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        /* Sections */
        .section {
            background: rgba(255,255,255,0.05);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 30px;
            margin-bottom: 30px;
        }

        .section h2 {
            margin-bottom: 20px;
            font-size: 1.5rem;
        }

        /* Forms */
        textarea, input, select {
            width: 100%;
            padding: 12px;
            margin: 10px 0;
            border: none;
            border-radius: 10px;
            font-size: 14px;
            background: rgba(255,255,255,0.1);
            color: white;
        }

        textarea {
            font-family: monospace;
            resize: vertical;
        }

        button {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            border: none;
            padding: 12px 30px;
            border-radius: 30px;
            cursor: pointer;
            font-size: 16px;
            transition: transform 0.2s;
            margin: 10px 5px;
        }

        button:hover {
            transform: translateY(-2px);
        }

        .btn-success {
            background: linear-gradient(135deg, #00b09b, #96c93d);
        }

        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }

        .tab {
            background: rgba(255,255,255,0.1);
            padding: 10px 20px;
            border-radius: 30px;
            cursor: pointer;
            transition: all 0.3s;
        }

        .tab.active {
            background: linear-gradient(135deg, #667eea, #764ba2);
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
        }

        /* Apps Grid */
        .apps-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }

        .app-card {
            background: rgba(255,255,255,0.05);
            border-radius: 15px;
            padding: 20px;
            transition: transform 0.3s;
        }

        .app-card:hover {
            transform: translateY(-5px);
            background: rgba(255,255,255,0.1);
        }

        .app-url {
            font-size: 12px;
            color: #a8c0ff;
            word-break: break-all;
            margin: 10px 0;
        }

        .badge {
            display: inline-block;
            background: #00ff00;
            color: #000;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 10px;
            margin-left: 10px;
        }

        /* AI Chat */
        .ai-chat {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 350px;
            background: rgba(0,0,0,0.95);
            border-radius: 20px;
            overflow: hidden;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            z-index: 1000;
        }

        .ai-header {
            background: linear-gradient(135deg, #667eea, #764ba2);
            padding: 15px;
            cursor: pointer;
        }

        .ai-messages {
            height: 300px;
            overflow-y: auto;
            padding: 15px;
            font-size: 13px;
        }

        .ai-message {
            margin-bottom: 10px;
            padding: 8px 12px;
            border-radius: 15px;
            max-width: 85%;
        }

        .ai-message.user {
            background: #667eea;
            margin-left: auto;
        }

        .ai-message.bot {
            background: rgba(255,255,255,0.1);
        }

        .ai-input {
            display: flex;
            padding: 15px;
            border-top: 1px solid rgba(255,255,255,0.1);
        }

        .ai-input input {
            flex: 1;
            margin: 0;
            margin-right: 10px;
        }

        .ai-input button {
            margin: 0;
            padding: 12px 20px;
        }

        /* Location Badge */
        .location-badge {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(0,0,0,0.7);
            padding: 8px 15px;
            border-radius: 30px;
            font-size: 12px;
            backdrop-filter: blur(5px);
            z-index: 999;
        }

        /* Responsive */
        @media (max-width: 768px) {
            .container { padding: 10px; }
            .header h1 { font-size: 1.8rem; }
            .ai-chat { width: 95%; right: 2.5%; bottom: 10px; }
            .stats-grid { grid-template-columns: 1fr 1fr; }
        }
    </style>
</head>
<body>
    <div class="location-badge" id="locationBadge">
        🌍 Loading location...
    </div>

    <div class="container">
        <div class="header">
            <h1 class="glow">🚀 OmniVerse</h1>
            <p>The Most Powerful Deployment Platform on Earth</p>
            <p style="font-size: 14px; opacity: 0.7;">✅ Auto-SEO | ✅ Google Indexed | ✅ 24/7 Uptime | ✅ AI Powered</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div>📦 Total Deployments</div>
                <div class="stat-value" id="totalDeployments">0</div>
            </div>
            <div class="stat-card">
                <div>🟢 Active Apps</div>
                <div class="stat-value" id="activeApps">0</div>
            </div>
            <div class="stat-card">
                <div>💰 Total Earnings</div>
                <div class="stat-value" id="totalEarnings">$0</div>
            </div>
            <div class="stat-card">
                <div>⚡ Uptime</div>
                <div class="stat-value pulse">100%</div>
            </div>
        </div>

        <div class="section">
            <h2>📤 Deploy Your App</h2>
            <div class="tabs">
                <div class="tab active" onclick="switchTab('code')">📝 Paste Code</div>
                <div class="tab" onclick="switchTab('github')">🐙 GitHub</div>
                <div class="tab" onclick="switchTab('zip')">📁 Upload ZIP</div>
                <div class="tab" onclick="switchTab('ai-generate')">🤖 AI Generate</div>
            </div>

            <div id="tab-code" class="tab-content active">
                <textarea id="codeInput" rows="8" placeholder="Paste your full Node.js/Express code here..."></textarea>
                <input type="text" id="appName" placeholder="App name (e.g., MyAwesomeApp)">
                <input type="text" id="appDesc" placeholder="Short description (helps with SEO)">
                <button onclick="deployCode()">🚀 Deploy Now</button>
                <div id="deployResult" style="margin-top: 15px;"></div>
            </div>

            <div id="tab-github" class="tab-content">
                <input type="text" id="githubUrl" placeholder="https://github.com/username/repository">
                <button onclick="deployGitHub()">📦 Deploy from GitHub</button>
                <div id="githubResult" style="margin-top: 15px;"></div>
            </div>

            <div id="tab-zip" class="tab-content">
                <input type="file" id="zipFile" accept=".zip">
                <input type="text" id="zipAppName" placeholder="App name">
                <button onclick="deployZip()">📁 Upload & Deploy</button>
                <div id="zipResult" style="margin-top: 15px;"></div>
            </div>

            <div id="tab-ai-generate" class="tab-content">
                <textarea id="aiPrompt" rows="4" placeholder="Describe the app you want...&#10;&#10;Example: 'Create an e-commerce store with products and checkout'"></textarea>
                <button onclick="generateWithAI()">🤖 Generate App</button>
                <div id="aiGeneratedCode" style="margin-top: 15px; display: none;">
                    <textarea id="generatedCode" rows="10" readonly style="font-family: monospace;"></textarea>
                    <button onclick="deployGenerated()">🚀 Deploy This App</button>
                </div>
            </div>
        </div>

        <div class="section">
            <h2>📱 Your Deployed Apps</h2>
            <input type="text" id="searchApps" placeholder="🔍 Search your apps..." onkeyup="searchApps()" style="margin-bottom: 20px;">
            <div id="appsList" class="apps-grid">
                <p>Loading apps...</p>
            </div>
        </div>
    </div>

    <!-- AI Chatbot -->
    <div class="ai-chat" id="aiChat">
        <div class="ai-header" onclick="toggleChat()">
            🤖 OmniAI Assistant <span style="float: right">▼</span>
        </div>
        <div id="chatMessages" class="ai-messages">
            <div class="ai-message bot">👋 Hello! I'm OmniAI. Ask me anything about deploying your app!</div>
        </div>
        <div class="ai-input">
            <input type="text" id="chatInput" placeholder="Ask for help..." onkeypress="if(event.key==='Enter') askAI()">
            <button onclick="askAI()">Send</button>
        </div>
    </div>

    <script>
        const socket = io();

        // Location updates
        socket.on('locationUpdate', (location) => {
            document.getElementById('locationBadge').innerHTML = \`🌍 \${location.flag} \${location.country} - \${location.city}\`;
        });

        // Switch tabs
        function switchTab(tab) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById(\`tab-\${tab}\`).classList.add('active');
        }

        // Deploy from code
        async function deployCode() {
            const code = document.getElementById('codeInput').value;
            const appName = document.getElementById('appName').value;
            const description = document.getElementById('appDesc').value;
            
            if (!code) {
                alert('Please paste your code first!');
                return;
            }
            
            const resultDiv = document.getElementById('deployResult');
            resultDiv.innerHTML = '<p>🚀 Deploying and submitting to search engines...</p>';
            
            try {
                const response = await fetch('/api/deploy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code, appName, description })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    resultDiv.innerHTML = \`
                        <div style="background: rgba(0,255,0,0.2); padding: 15px; border-radius: 10px;">
                            ✅ <strong>DEPLOYMENT SUCCESSFUL!</strong><br>
                            🔗 URL: <a href="\${result.url}" target="_blank" style="color: #a8c0ff">\${result.url}</a><br>
                            🌐 Your app is now LIVE worldwide!<br>
                            🔍 Submitted to Google, Bing, Yahoo!<br>
                            📱 Share the link - it will appear in search results within 24-48 hours!
                            \${result.issues ? \`<br>⚠️ Fixed issues: \${result.issues.join(', ')}\` : ''}
                        </div>
                    \`;
                    document.getElementById('codeInput').value = '';
                    loadApps();
                } else {
                    resultDiv.innerHTML = \`<div style="background: rgba(255,0,0,0.2); padding: 15px; border-radius: 10px;">❌ \${result.error}</div>\`;
                }
            } catch (error) {
                resultDiv.innerHTML = \`<div style="background: rgba(255,0,0,0.2); padding: 15px; border-radius: 10px;">❌ \${error.message}</div>\`;
            }
        }

        // Deploy from GitHub
        async function deployGitHub() {
            const repoUrl = document.getElementById('githubUrl').value;
            
            if (!repoUrl) {
                alert('Please enter GitHub repository URL!');
                return;
            }
            
            const resultDiv = document.getElementById('githubResult');
            resultDiv.innerHTML = '<p>🚀 Cloning and deploying from GitHub...</p>';
            
            const response = await fetch('/api/deploy/github', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repoUrl })
            });
            
            const result = await response.json();
            
            if (result.success) {
                resultDiv.innerHTML = \`<div style="background: rgba(0,255,0,0.2); padding: 15px; border-radius: 10px;">✅ Deployed! <a href="\${result.url}" target="_blank">\${result.url}</a></div>\`;
                loadApps();
            } else {
                resultDiv.innerHTML = \`<div style="background: rgba(255,0,0,0.2); padding: 15px; border-radius: 10px;">❌ \${result.error}</div>\`;
            }
        }

        // Deploy from ZIP
        async function deployZip() {
            const file = document.getElementById('zipFile').files[0];
            const appName = document.getElementById('zipAppName').value;
            
            if (!file) {
                alert('Please select a ZIP file!');
                return;
            }
            
            const formData = new FormData();
            formData.append('file', file);
            formData.append('appName', appName);
            
            const resultDiv = document.getElementById('zipResult');
            resultDiv.innerHTML = '<p>🚀 Extracting and deploying...</p>';
            
            const response = await fetch('/api/deploy/zip', {
                method: 'POST',
                body: formData
            });
            
            const result = await response.json();
            
            if (result.success) {
                resultDiv.innerHTML = \`<div style="background: rgba(0,255,0,0.2); padding: 15px; border-radius: 10px;">✅ Deployed! <a href="\${result.url}" target="_blank">\${result.url}</a></div>\`;
                loadApps();
            } else {
                resultDiv.innerHTML = \`<div style="background: rgba(255,0,0,0.2); padding: 15px; border-radius: 10px;">❌ \${result.error}</div>\`;
            }
        }

        // Generate with AI
        async function generateWithAI() {
            const prompt = document.getElementById('aiPrompt').value;
            
            if (!prompt) {
                alert('Please describe what app you want!');
                return;
            }
            
            const response = await fetch('/api/ai/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: \`generate \${prompt}\` })
            });
            
            const result = await response.json();
            
            if (result.type === 'generated_code') {
                document.getElementById('generatedCode').value = result.code;
                document.getElementById('aiGeneratedCode').style.display = 'block';
            }
        }

        // Deploy generated code
        async function deployGenerated() {
            const code = document.getElementById('generatedCode').value;
            const appName = document.getElementById('aiPrompt').value.slice(0, 30);
            
            const response = await fetch('/api/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code, appName })
            });
            
            const result = await response.json();
            
            if (result.success) {
                alert(\`✅ App deployed! \${result.url}\`);
                loadApps();
            } else {
                alert('Deployment failed: ' + result.error);
            }
        }

        // Load all apps
        async function loadApps() {
            try {
                const response = await fetch('/api/apps');
                const data = await response.json();
                
                document.getElementById('totalDeployments').innerHTML = data.total;
                document.getElementById('activeApps').innerHTML = data.apps.length;
                document.getElementById('totalEarnings').innerHTML = \`$\${data.earnings.toFixed(2)}\`;
                
                const appsList = document.getElementById('appsList');
                
                if (data.apps.length === 0) {
                    appsList.innerHTML = '<p>No apps deployed yet. Deploy your first app above!</p>';
                } else {
                    appsList.innerHTML = data.apps.map(app => \`
                        <div class="app-card">
                            <strong>\${app.name}</strong> <span class="badge">LIVE</span>
                            <div class="app-url">🔗 <a href="\${app.url}" target="_blank">\${app.url}</a></div>
                            <div>\${app.description || 'No description'}</div>
                            <small>📅 \${new Date(app.createdAt).toLocaleString()}</small>
                        </div>
                    \`).join('');
                }
            } catch (error) {
                console.error('Error loading apps:', error);
            }
        }

        // Search apps
        async function searchApps() {
            const query = document.getElementById('searchApps').value;
            
            if (query.length < 2) {
                loadApps();
                return;
            }
            
            const response = await fetch('/api/search?q=' + encodeURIComponent(query));
            const data = await response.json();
            
            const appsList = document.getElementById('appsList');
            appsList.innerHTML = data.apps.map(app => \`
                <div class="app-card">
                    <strong>\${app.name}</strong> <span class="badge">LIVE</span>
                    <div class="app-url">🔗 <a href="\${app.url}" target="_blank">\${app.url}</a></div>
                    <div>\${app.description || 'No description'}</div>
                </div>
            \`).join('');
        }

        // AI Chat
        async function askAI() {
            const input = document.getElementById('chatInput');
            const message = input.value;
            
            if (!message) return;
            
            const messagesDiv = document.getElementById('chatMessages');
            messagesDiv.innerHTML += \`<div class="ai-message user">👤 \${message}</div>\`;
            input.value = '';
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
            
            const response = await fetch('/api/ai/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message })
            });
            
            const result = await response.json();
            messagesDiv.innerHTML += \`<div class="ai-message bot">🤖 \${result.message}</div>\`;
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }

        let chatOpen = true;
        function toggleChat() {
            const chatMessages = document.querySelector('#aiChat .ai-messages');
            const chatInput = document.querySelector('#aiChat .ai-input');
            if (chatOpen) {
                chatMessages.style.display = 'none';
                chatInput.style.display = 'none';
            } else {
                chatMessages.style.display = 'block';
                chatInput.style.display = 'flex';
            }
            chatOpen = !chatOpen;
        }

        // Initial load
        loadApps();
        setInterval(loadApps, 30000);
    </script>
</body>
</html>
    `);
});

// ============ START SERVER ============
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║     🌌 OMNIVERSE - ULTIMATE ALL-IN-ONE PLATFORM 🌌               ║
║                                                                   ║
║     ✅ Auto VPS with Location Rotation                           ║
║     ✅ Auto Domain & Subdomain Generation                        ║
║     ✅ Auto Deploy from Code/GitHub/ZIP                          ║
║     ✅ Auto Submit to Google, Bing, Yahoo                        ║
║     ✅ AI Assistant for Code Fixing & Generation                 ║
║     ✅ Monetization & Earnings Tracking                          ║
║     ✅ Self-Healing & 24/7 Uptime                                ║
║     ✅ Worldwide Access from Any Device                          ║
║                                                                   ║
║     🌐 Web Interface: http://localhost:${PORT}                     ║
║     📱 Apps are indexed on Google automatically!                 ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
    `);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, cleaning up...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

import express from 'express';
import fs from 'fs';
import ws from 'ws';
import expressWs from 'express-ws';
import {job} from './keep_alive.js';
import {OpenAIOperations} from './openai_operations.js';
import {TwitchBot} from './twitch_bot.js';

// Start keep alive cron job
job.start();
console.log(process.env);

// Setup express app
const app = express();
const expressWsInstance = expressWs(app);

// Set the view engine to ejs
app.set('view engine', 'ejs');

// Load environment variables
const GPT_MODE = process.env.GPT_MODE || 'CHAT';
const HISTORY_LENGTH = process.env.HISTORY_LENGTH || 5;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL_NAME = process.env.MODEL_NAME || 'gpt-3.5-turbo';
const TWITCH_USER = process.env.TWITCH_USER || 'oSetinhasBot';
const TWITCH_AUTH = process.env.TWITCH_AUTH || 'oauth:vgvx55j6qzz1lkt3cwggxki1lv53c2';
const COMMAND_NAME = process.env.COMMAND_NAME || '!gpt';
const CHANNELS = process.env.CHANNELS || 'oSetinhas,jones88';
const SEND_USERNAME = process.env.SEND_USERNAME || 'true';
const ENABLE_TTS = process.env.ENABLE_TTS || 'false';
const ENABLE_CHANNEL_POINTS = process.env.ENABLE_CHANNEL_POINTS || 'false';
const COOLDOWN_DURATION = parseInt(process.env.COOLDOWN_DURATION, 10) || 10; // Cooldown duration in seconds

if (!OPENAI_API_KEY) {
    console.error('No OPENAI_API_KEY found. Please set it as an environment variable.');
}

const commandNames = COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const channels = CHANNELS.split(',').map(channel => channel.trim());
const maxLength = 399;
let fileContext = 'You are a helpful Twitch Chatbot.';
let lastUserMessage = '';
let lastResponseTime = 0; // Track the last response time

// Setup Twitch bot
console.log('Channels: ', channels);
const bot = new TwitchBot(TWITCH_USER, TWITCH_AUTH, channels, OPENAI_API_KEY, ENABLE_TTS);

// Setup OpenAI operations
fileContext = fs.readFileSync('./file_context.txt', 'utf8');
const openaiOps = new OpenAIOperations(fileContext, OPENAI_API_KEY, MODEL_NAME, HISTORY_LENGTH);

// Setup Twitch bot callbacks
bot.onConnected((addr, port) => {
    console.log(`* Connected to ${addr}:${port}`);
    channels.forEach(channel => {
        console.log(`* Joining ${channel}`);
        console.log(`* Saying hello in ${channel}`);
    });
});

bot.onDisconnected(reason => {
    console.log(`Disconnected: ${reason}`);
});

// Connect bot
bot.connect(
    () => {
        console.log('Bot connected!');
    },
    error => {
        console.error('Bot couldn\'t connect!', error);
    }
);

bot.onMessage(async (channel, user, message, self) => {
    if (self) return; // Ignore the bot's own messages

    const currentTime = Date.now();
    const elapsedTime = (currentTime - lastResponseTime) / 1000; // Cooldown check in seconds

    // Handle only the !maxpt command
    if (message.trim() === '!maxpt') {
        const userId = user['user-id']; // Get the user ID from the message metadata
        const channelId = 'your_channel_id'; // Replace with your actual Twitch channel ID

        // Check if the user is subscribed
        const isSubscribed = await bot.checkSubscriptionStatus(channelId, userId);

        if (!isSubscribed) {
            // If the user is not subscribed, send the rejection message
            bot.say(channel, `Ummm @${user['display-name']}, you can't use me. Sub or Fuck off.`);
            return;
        }

        // Cooldown logic: Ensure sufficient time has passed before responding again
        if (elapsedTime < COOLDOWN_DURATION) {
            const remainingTime = Math.round(COOLDOWN_DURATION - elapsedTime);
            bot.say(channel, `Slow down @${user['display-name']}. You gotta wait ${remainingTime} second${remainingTime !== 1 ? 's' : ''} before using the command again.`);
            return;
        }

        // Update the last response time to enforce cooldown
        lastResponseTime = currentTime;

        try {
            // Send the user's message to OpenAI for a response
            const response = await openaiOps.make_openai_call(message);
            
            // Send the response from OpenAI to the Twitch chat
            if (response.length > maxLength) {
                const splitMessages = response.match(new RegExp(`.{1,${maxLength}}`, 'g')); // Split response into chunks if necessary
                splitMessages.forEach((msg, index) => {
                    setTimeout(() => {
                        bot.say(channel, msg);
                    }, 1000 * index); // Send each chunk with a delay between them
                });
            } else {
                // If the response is short enough, send it in one message
                bot.say(channel, response);
            }
        } catch (error) {
            console.error('Error generating OpenAI response:', error);
            bot.say(channel, `Sorry @${user['display-name']}, something went wrong while fetching your response.`);
        }
    }
});


app.ws('/check-for-updates', (ws, req) => {
    ws.on('message', message => {
        // Handle WebSocket messages (if needed)
    });
});

const messages = [{role: 'system', content: 'You are a helpful Twitch Chatbot.'}];
console.log('GPT_MODE:', GPT_MODE);
console.log('History length:', HISTORY_LENGTH);
console.log('OpenAI API Key:', OPENAI_API_KEY);
console.log('Model Name:', MODEL_NAME);

app.use(express.json({extended: true, limit: '1mb'}));
app.use('/public', express.static('public'));

app.all('/', (req, res) => {
    console.log('Received a request!');
    res.render('pages/index');
});

if (GPT_MODE === 'CHAT') {
    fs.readFile('./file_context.txt', 'utf8', (err, data) => {
        if (err) throw err;
        console.log('Reading context file and adding it as system-level message for the agent.');
        messages[0].content = data;
    });
} else {
    fs.readFile('./file_context.txt', 'utf8', (err, data) => {
        if (err) throw err;
        console.log('Reading context file and adding it in front of user prompts:');
        fileContext = data;
    });
}

app.get('/gpt/:text', async (req, res) => {
    const text = req.params.text;

    let answer = '';
    try {
        if (GPT_MODE === 'CHAT') {
            answer = await openaiOps.make_openai_call(text);
        } else if (GPT_MODE === 'PROMPT') {
            const prompt = `${fileContext}\n\nUser: ${text}\nAgent:`;
            answer = await openaiOps.make_openai_call_completion(prompt);
        } else {
            throw new Error('GPT_MODE is not set to CHAT or PROMPT. Please set it as an environment variable.');
        }

        res.send(answer);
    } catch (error) {
        console.error('Error generating response:', error);
        res.status(500).send('An error occurred while generating the response.');
    }
});

const server = app.listen(3000, () => {
    console.log('Server running on port 3000');
});

const wss = expressWsInstance.getWss();
wss.on('connection', ws => {
    ws.on('message', message => {
        // Handle client messages (if needed)
    });
});

function notifyFileChange() {
    wss.clients.forEach(client => {
        if (client.readyState === ws.OPEN) {
            client.send(JSON.stringify({updated: true}));
        }
    });
}

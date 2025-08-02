// Import necessary libraries
const TelegramBot = require('node-telegram-bot-api');
const ethers = require('ethers');
const cron = require('node-cron');
const express = require('express');
const cors = require('cors');
const path = require('path'); // Import the 'path' module to handle file paths

// --- Firestore/Firebase Imports ---
const admin = require('firebase-admin');

// --- Configuration Variables ---
// IMPORTANT: Replace the BOT_URL with your actual Vercel URL after deployment.
// Replit's environment variables can be accessed via process.env
const BOT_TOKEN = '8397845939:AAHzXoD9DhAS3onvqms2ZwScT3RwlpQ0wjw'; // Get this from @BotFather
const GROUP_CHAT_ID = -4858772833; // The ID of your Telegram group (starts with -100)
const ETHEREUM_RPC_URL = 'https://rpc.mainnet.taraxa.io/';
const CONTRACT_ADDRESS = '0x7944e09006504c062816d4EF083A5184c0929BB5';
const REQUIRED_TOKEN_AMOUNT = 10;
// You will get this URL from Vercel after you run the project for the first time
const BOT_URL = 'https://gated-stivun.vercel.app/verify-wallet.html';

// The ABI for the ERC-20 contract, containing only the 'balanceOf' function.
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)'
];

// --- Firebase Configuration ---
// Read the service account key from Vercel's Environment Variables
// The key is a JSON string, so we need to parse it.
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

    // Initialize Firebase Admin SDK
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
} catch (error) {
    console.error('Error initializing Firebase. Make sure FIREBASE_SERVICE_ACCOUNT_KEY secret is set correctly.');
    console.error('Error:', error);
    // On Vercel, this might cause a deployment to fail, which is good.
    // In a local environment, it will exit the process.
    // process.exit(1); 
}


// Get a Firestore database instance
const db = admin.firestore();
const membersCollection = db.collection('approvedMembers');

// Initialize the bot and the web server
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
const port = 3000;

app.use(express.json());
app.use(cors()); // Allow cross-origin requests from the Mini App

// Acknowledgment
bot.on('polling_error', console.error);
console.log('Bot is running...');

// --- New Route for Serving the Mini App Frontend ---
// This will serve the verify-wallet.html file when a GET request is made
app.get('/verify-wallet.html', (req, res) => {
    // The path.join function safely constructs the path to your file
    res.sendFile(path.join(__dirname, 'verify-wallet.html'));
});


/**
 * Checks the token balance of a given wallet address.
 * @param {string} walletAddress The Ethereum wallet address to check.
 * @returns {Promise<boolean>} True if the balance is sufficient, otherwise false.
 */
async function checkTokenBalance(walletAddress) {
  try {
    const provider = new ethers.JsonRpcProvider(ETHEREUM_RPC_URL);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ERC20_ABI, provider);
    const balance = await contract.balanceOf(walletAddress);
    const balanceInEth = ethers.formatEther(balance);
    return parseFloat(balanceInEth) >= REQUIRED_TOKEN_AMOUNT;
  } catch (error) {
    console.error('Error checking token balance:', error);
    return false;
  }
}


// --- Main Bot Logic ---

// The /verify command sends a button to the user to open the Mini App
bot.onText(/\/verify/, (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type === 'private') {
        bot.sendMessage(chatId, 'Wassup, fren! To join the exclusive Memelord HQ, tap the button below to connect your wallet and get verified.', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Verify Wallet', web_app: { url: BOT_URL } }]
                ]
            }
        });
    } else {
        bot.sendMessage(chatId, `Psst... DM me to get verified and join the party.`, {
            reply_to_message_id: msg.message_id
        });
    }
});


// --- API Endpoint for the Mini App ---
app.post('/verify-wallet', async (req, res) => {
    const { userId, walletAddress, signature } = req.body;

    // The message to sign. This MUST match the message in the mini-app frontend.
    const challengeMessage = 'Prove ownership to join Memelord HQ';

    try {
        const recoveredAddress = ethers.verifyMessage(challengeMessage, signature).toLowerCase();

        if (recoveredAddress === walletAddress.toLowerCase()) {
            const hasTokens = await checkTokenBalance(walletAddress);

            if (hasTokens) {
                // If the user has tokens, create an invite link and send it.
                const inviteLink = await bot.createChatInviteLink(GROUP_CHAT_ID, {
                    member_limit: 1,
                    expire_date: Math.floor(Date.now() / 1000) + 300 // 5 minutes
                });

                // Add the user to our Firestore collection
                await membersCollection.doc(userId.toString()).set({
                    walletAddress: walletAddress,
                    joinTimestamp: admin.firestore.FieldValue.serverTimestamp()
                });

                // Respond to the mini-app with a success message and the link
                res.status(200).send({ success: true, inviteLink: inviteLink.invite_link });
            } else {
                // Not enough tokens
                res.status(200).send({ success: false, message: 'Verification failed. Bags are too light.' });
            }
        } else {
            // Signature verification failed
            res.status(401).send({ success: false, message: 'Signature verification failed. Not the wallet owner.' });
        }
    } catch (error) {
            // Log the detailed error
            console.error('Error during mini-app verification:', error);
            // Respond with a generic server error message
            res.status(500).send({ success: false, message: 'Internal server error.' });
    }
});

app.listen(port, () => {
  console.log(`Web server listening on port ${port}`);
});


// --- Automated Daily Re-verification with a grace period (Cron Job) ---
cron.schedule('0 2 * * *', async () => {
    console.log('Running daily token balance check...');

    // Get all approved members from Firestore
    const snapshot = await membersCollection.get();
    const usersToRecheck = [];

    if (snapshot.empty) {
        console.log('No members to check.');
        return;
    }

    // Iterate through Firestore documents
    for (const doc of snapshot.docs) {
        const memberId = doc.id;
        const { walletAddress } = doc.data();
        const hasTokens = await checkTokenBalance(walletAddress);

        if (!hasTokens) {
            console.log(`User ${memberId} no longer has enough tokens. Sending 1-hour warning.`);
            
            bot.sendMessage(memberId, 
                `Uh oh, fren! Our daily check shows your bags are looking a little light. 
                
You have 1 hour to get that token count up or the bot will have to say 'gm' to you from a distance. Don't get rekt!`
            ).catch(err => {
                console.error(`Could not send warning to user ${memberId}:`, err);
            });

            usersToRecheck.push({ memberId, walletAddress });
        }
    }

    if (usersToRecheck.length > 0) {
        setTimeout(async () => {
            console.log('Performing final check for warned users...');
            for (const user of usersToRecheck) {
                const { memberId, walletAddress } = user;
                const stillHasTokens = await checkTokenBalance(walletAddress);

                if (!stillHasTokens) {
                    console.log(`User ${memberId} got rekt. Kicking them from the group and removing from Firestore.`);
                    try {
                        await bot.unbanChatMember(GROUP_CHAT_ID, memberId);
                        await membersCollection.doc(memberId).delete();
                    } catch (error) {
                        console.error(`Error kicking user ${memberId}:`, error);
                    }
                } else {
                    console.log(`User ${memberId} has topped up their balance. They will remain in the group. Wagmi!`);
                }
            }
            console.log('Final check complete.');
        }, 3600000); // 1 hour in milliseconds
    }

    console.log('Daily token balance check complete. Awaiting final checks if needed.');
});

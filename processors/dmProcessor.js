import { generateResponse } from '../handlers/responseGenerator.js';
import { replyDM, getUserOverview, getInboxMessagesFromUser } from '../lib/redditClient.js';

const MAX_MSGS = 40;

async function buildConversationContext(sender) {
  try {
    const inboxMessages = await getInboxMessagesFromUser(sender, MAX_MSGS);

    if (inboxMessages.length === 0) {
      console.log(`No conversation history found for user ${sender}`);
      return '';
    }

    const conversationLines = inboxMessages.map((msg) => {
      const role = msg.direction === 'bot' ? '[bot]' : `[${sender}]`;
      const timestamp = new Date(msg.created_utc * 1000).toISOString();
      return `${role} (${timestamp}): ${msg.body}`;
    });

    console.log(`Built conversation context for ${sender}: ${inboxMessages.length} messages`);
    return `\nConversation History with u/${sender} (last ${inboxMessages.length} messages, chronological order):\n${conversationLines.join('\n')}\n`;
  } catch (error) {
    console.error(`Error building conversation context for ${sender}:`, error.message);
    return '';
  }
}

async function newDMProcessor(messages) {
  for (const message of messages) {
    try {
      console.log(`Processing DM ${message.id} from ${message.sender}: ${message.body.slice(0, 100)}...`);

      // Fetch conversation history for richer context
      const conversationContext = await buildConversationContext(message.sender);
      const baseContext = `This message is from u/${message.sender}`;
      const fullContext = conversationContext
        ? `${baseContext}\n${conversationContext}`
        : baseContext;

      let response = await generateResponse(message, true, false, fullContext);
      while (response.action === 'query_user') {
        const username = response.text;
        console.log(`Querying user ${username} for DM ${message.id}`);
        const userData = await getUserOverview(username);
        const userContext = userData
          .map((item) => `${item.kind === 't3' ? 'Post' : 'Comment'} in r/${item.subreddit}: ${item.content}`)
          .join('\n');
        response = await generateResponse(message, true, false, `${fullContext}\nUser ${username} context:\n${userContext}`);
      }
      if (response.action === 'reply' && response.text !== '0canthelpwiththisquery0') {
        await replyDM(message.id, response.text);
        console.log(`Sent DM response to ${message.sender}: ${response.text}`);
      } else {
        await replyDM(message.id, `I cannot help with this query.\n\n*I'm a bot*⋆.˚ ᡣ𐭩 .𖥔˚`);
        console.log(`Sent fallback response for DM ${message.id}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`Error processing DM ${message.id}:`, error.message);
    }
  }
}

export { newDMProcessor };

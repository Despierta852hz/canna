import { NextRequest, NextResponse } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { Message as VercelChatMessage, StreamingTextResponse } from "ai";
import { AIMessage, ChatMessage, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { createRetrieverTool } from "langchain/tools/retriever";
import { AgentExecutor, createOpenAIFunctionsAgent } from "langchain/agents";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { UpstashVectorStore } from "@/app/vectorstore/UpstashVectorStore";
async function fetchTextFile(url: string | URL | Request) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Network response was not ok ' + response.statusText);
    }
    const text = await response.text();
    console.log(text);
    return text;
  } catch (error) {
    console.error('There has been a problem with your fetch operation:', error);
  }
}

export const runtime = "edge";

const redis = Redis.fromEnv();

const ratelimit = new Ratelimit({
  redis: redis,
  limiter: Ratelimit.slidingWindow(1, "10 s"),
});

const convertVercelMessageToLangChainMessage = (message: VercelChatMessage) => {
  if (message.role === "user") {
    return new HumanMessage(message.content);
  } else if (message.role === "assistant") {
    return new AIMessage(message.content);
  } else {
    return new ChatMessage(message.content, message.role);
  }
};

export async function POST(req: NextRequest) {
  try {
    const ip = req.ip ?? "127.0.0.1";
    const { success } = await ratelimit.limit(ip);

    if (!success) {
      const textEncoder = new TextEncoder();
      const customString =
        "Oops! It seems you've reached the rate limit. Please try again later.";

      const transformStream = new ReadableStream({
        async start(controller) {
          controller.enqueue(textEncoder.encode(customString));
          controller.close();
        },
      });
      return new StreamingTextResponse(transformStream);
    }

    const body = await req.json();
    console.log("Received additional data:", body.additionalData); // Log additional data
    const name =body.additionalData.name
    const rand =Number(body.additionalData.rand)
    console.log("hana hna awjah lkhorza ")
    console.log(rand)

    /**
     * We represent intermediate steps as system messages for display purposes,
     * but don't want them in the chat history.
     */
    const messages = (body.messages ?? []).filter(
      (message: VercelChatMessage) =>
        message.role === "user" || message.role === "assistant",
    );
    const returnIntermediateSteps = true;
    const previousMessages = messages
      .slice(0, -1)
      .map(convertVercelMessageToLangChainMessage);
    const currentMessageContent = messages[messages.length - 1].content;

    const chatModel = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0.2,
      streaming: true,
    });

    const vectorstore = await new UpstashVectorStore(new OpenAIEmbeddings());
    const retriever = vectorstore.asRetriever(
      {
        k: 6,
        searchType: "mmr",
        searchKwargs: {
          fetchK: 10,
          lambda: 0.5
        },
        verbose: false
      },
    );

    const tool = createRetrieverTool(retriever, {
      name: "Cbdmex_knowledge_base",
      description: "Use it to fetch information and specific recommandation from Cbdmex and cannabis related products  ",
    });

    const default_prompt = `
    Objective:
Create detailed user profiles to recommend cannabis products, medicinal mushrooms, health supplements, and wellness items. Engage users in a conversational and persuasive manner, leading them toward making a purchase while encouraging them to register on CBDMEX for personalized offers and recommendations.

Canna AI Role:
You are Canna AI, an AI-powered chatbot that helps users find the right cannabis, mushroom-based products, and wellness supplements for their health and well-being.

Request for Information:
Ask relevant questions about the user’s health concerns, interests, and preferences to guide them toward the most suitable products.

Mandatory Initial Information:
Ask for the user’s name: Start by asking for the user’s name to create a personalized experience.
Ask for the health goal: Find out what the user is looking to improve (e.g., stress relief, pain management, sleep improvement).
Topics You Can Discuss:
Cannabis Medicine: Highlight how cannabis can be used for medicinal purposes, its benefits, and recommended products.
Medicinal Mushrooms: Talk about the health benefits of mushrooms like Lion’s Mane and Reishi. Recommend products based on their goals.
Health Supplements: Recommend CBD oils, balms, or other health supplements based on the user’s needs.
Natural Health Products: Recommend products from CBDMEX that fit the user’s well-being focus (e.g., reducing anxiety, boosting energy).
Guidelines:
Engage in Entertaining Conversations: Keep the conversation friendly, persuasive, and entertaining. Encourage the user to interact more.
Use Contextual Follow-Up Questions: Tailor your questions based on the user's responses to keep the conversation flowing smoothly.
Highlight Benefits: When recommending products, emphasize their benefits and how they help the user achieve their health goals.
Include Images and Links: Provide links and product images to enhance the user’s experience.
Encourage Purchases: Guide the conversation toward making a purchase without being too pushy.
Tools Usage:
Cbdmex_knowledge_base: Use this to provide accurate product recommendations based on availability and user preferences.
OpenAI: Use for general health-related information if needed, while ensuring the conversation is engaging.
Mid-Conversation Registration Reminder:
If the user isn’t registered, remind them to sign up on cbdmex.com/login to receive personalized offers and product recommendations.

Flexible and Engaging Conversation Flow:
Canna AI: Hey! I’m Canna AI, your health and wellness guide at CBDMEX. I’m here to help you find the best cannabis and wellness products. What’s your name?

User: My name is Alex.

Canna AI: Nice to meet you, Alex! What health goals are you focusing on? Stress relief, better sleep, or perhaps something else?

User: I need help with sleep.

Canna AI: Sleep is essential! We have some great CBD oils and mushroom supplements that work wonders for sleep improvement. Have you tried any of these before?

User: I haven’t. Tell me more about the oils.

Canna AI: Absolutely! Our CBD Sleep Oil is formulated to promote relaxation and a restful night’s sleep. I’d recommend giving it a try. I can also show you other options if you’re interested!

User: That sounds great.

Canna AI: I’ll send you the link! You can also register on our site to get a discount on your first order and receive personalized recommendations in the future. Would you like the registration link?

User: Sure, send it over.

Canna AI: Fantastic! Here’s the registration link: cbdmex.com/login. Once you register, I can help you find more personalized products. Let me know if you need anything else, Alex!
`
    
    const AGENT_SYSTEM_TEMPLATE = await fetchTextFile("https://remote-static.vercel.app/cannaai.txt") ?? default_prompt;

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", AGENT_SYSTEM_TEMPLATE],
      new MessagesPlaceholder("chat_history"),
      ["human", "{input}"],
      new MessagesPlaceholder("agent_scratchpad"),
    ]);

    const agent = await createOpenAIFunctionsAgent({
      llm: chatModel,
      tools: [tool],
      prompt,
    });

    const agentExecutor = new AgentExecutor({
      agent,
      tools: [tool],
      // Set this if you want to receive all intermediate steps in the output of .invoke().
      returnIntermediateSteps,
    });

    if (!returnIntermediateSteps) {
      const logStream = await agentExecutor.streamLog({
        input: currentMessageContent,
        chat_history: previousMessages,
      });

      const textEncoder = new TextEncoder();
      const transformStream = new ReadableStream({
        async start(controller) {
          for await (const chunk of logStream) {
            if (chunk.ops?.length > 0 && chunk.ops[0].op === "add") {
              const addOp = chunk.ops[0];
              if (
                addOp.path.startsWith("/logs/ChatOpenAI") &&
                typeof addOp.value === "string" &&
                addOp.value.length
              ) {
                controller.enqueue(textEncoder.encode(addOp.value));
              }
            }
          }
          controller.close();
        },
      });

      return new StreamingTextResponse(transformStream);
    } else {
      /**
       * Intermediate steps are the default outputs with the executor's `.stream()` method.
       * We could also pick them out from `streamLog` chunks.
       * They are generated as JSON objects, so streaming them is a bit more complicated.
       */
      console.log("iam here")
      console.log(currentMessageContent)
      const result = await agentExecutor.invoke({
        input: currentMessageContent,
        chat_history: previousMessages,
      });
      console.log(result)

      return new NextResponse(result.output);
    }
  } catch (e: any) {
    console.log(e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

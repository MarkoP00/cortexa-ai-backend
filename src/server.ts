import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { StreamChat } from "stream-chat";
import OpenAI from "openai";
import { db } from "./config/database.js";
import { chats, users } from "./db/schema.js";
import { eq } from "drizzle-orm";
import { ChatCompletionMessageParam } from "openai/resources.mjs"; //ovo je open ai resource

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Stream Chat Client
const chatClient = StreamChat.getInstance(
  process.env.STREAM_API_KEY!,
  process.env.STREAM_API_SECRET! // uzvicnik govori da ovo sigurno nece biti prazno
);

// Initialize OpenAI API
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Register user with Stream Chat app
app.post(
  "/register-user",
  async (req: Request, res: Response): Promise<any> => {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required." });
    }

    try {
      const userId = email.replace(/[^a-zA-Z0-9_-]/g, "_");

      const userResponse = await chatClient.queryUsers({ id: { $eq: userId } }); //proveravamo da li postoji user sa tim id-om. Dobijamo [] ako nema tog usera

      if (!userResponse.users.length) {
        // Add new user to Stream Chat
        await chatClient.upsertUser({
          id: userId,
          name: name,
          email: email,
          role: "user",
        } as any);
      }

      // Check for existing user in Neon database
      const existingUser = await db
        .select()
        .from(users)
        .where(eq(users.userId, userId));

      if (!existingUser.length) {
        console.log(
          `User ${userId} does not exist in the database. Adding them...`
        );

        await db.insert(users).values({
          userId,
          name,
          email,
        });
      }

      res.status(200).json({ userId, name, email });
    } catch (error) {
      res.status(500).json({ error: "Internal Server Error." });
    }
  }
);

app.post("/check-user", async (req: Request, res: Response): Promise<any> => {
  if (!req.body) {
    res.status(400).json({ error: "Request body is missing..." });
  }

  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.userId, userId));

  res.status(200).json({ userId, existingUser });
});

// Send message to AI
app.post("/chat", async (req: Request, res: Response): Promise<any> => {
  if (!req.body) {
    return res.status(400).json({ error: "Request body is missing" });
  }

  const { message, userId } = req.body;

  if (!message || !userId) {
    return res.status(400).json({ error: "Message and user id are required" });
  }

  try {
    // Verify if user exists - Stream Chat
    const userResponse = await chatClient.queryUsers({ id: userId });

    if (!userResponse.users.length) {
      return res
        .status(404)
        .json({ error: "User not found. Please register first." });
    }

    // Chekc user in Neon database - saving chat in Neon base on line 143
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.userId, userId));

    if (!existingUser.length) {
      return res.status(404).json({
        error: "User not found in Neon database. Please register first!",
      });
    }

    //Fetch users past messages for context
    const chatHistory = await db
      .select()
      .from(chats)
      .where(eq(chats.userId, userId))
      .orderBy(chats.createdAt)
      .limit(10);

    //Format chat history for OpenAI
    const conversation: ChatCompletionMessageParam[] = chatHistory.flatMap(
      (chat) => [
        { role: "user", content: chat.message },
        { role: "assistant", content: chat.reply },
      ]
    );

    // Add latest user messages to the conversation
    conversation.push({ role: "user", content: message });

    // Send message to AI - GPT-3.5
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: conversation as ChatCompletionMessageParam[],
    });

    const aiMessage =
      aiResponse.choices[0].message?.content ?? "AI response not found.";

    //Save chat to Neon database
    await db.insert(chats).values({
      userId,
      message,
      reply: aiMessage,
    });

    // Create or get channel - Stream Chat
    const channel = chatClient.channel("messaging", `chat-${userId}`, {
      name: "Cortexa",
      created_by_id: "ai_bot",
    } as any);

    await channel.create();
    await channel.sendMessage({ text: aiMessage, user_id: "ai_bot" });

    return res.status(200).json({
      status: "success",
      reply: aiMessage,
    });
  } catch (error: any) {
    console.log("Error generating Ai response", error);

    return res.status(500).json({
      error: "Internal Server Error",
      details: error.message || error,
    });
  }
});

// Get chat history for a user
app.post("/get-messages", async (req: Request, res: Response): Promise<any> => {
  if (!req.body) {
    return res.status(400).json({ error: "Request body is missing" });
  }

  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const chatHistory = await db
      .select()
      .from(chats)
      .where(eq(chats.userId, userId));

    res.status(200).json({
      messages: chatHistory,
    });
  } catch (error) {
    console.log("Error fetching chat history", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

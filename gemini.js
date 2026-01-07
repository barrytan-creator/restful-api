// gemini.js
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Convert natural language query into structured search params
async function generateSearchParams(query, categories, racks, statuses) {
  const systemPrompt = `You are a search query converter for a Tool Manager Inventory system.
Convert the user's natural language query into a structured JSON format.

Available categories: ${categories}
Available racks: ${racks}
Available statuses: ${statuses}

Output JSON format:
{
  "categories": string[],
  "racks": string[],
  "statuses": string[]
}

Rules:
- Only use values from the available lists
- Return empty arrays if no values apply
- Infer categories, racks, and statuses from the query
- Return ONLY valid JSON, no explanations

User's query: ${query}
`;

  const aiResponse = await ai.models.generateContent({
    model: MODEL,
    contents: systemPrompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          categories: { type: "array", items: { type: "string" } },
          racks: { type: "array", items: { type: "string" } },
          statuses: { type: "array", items: { type: "string" } }
        },
        required: ["categories", "racks", "statuses"]
      }
    }
  });

  return JSON.parse(aiResponse.text);
}

// Parse tool description into structured tool object
async function generateTool(toolText, availableCategories, availableStatuses) {
  const systemPrompt = `You are a tool parser. Convert the user's natural language tool description into a structured tool format.

Available categories: ${availableCategories.join(', ')}
Available statuses: ${availableStatuses.join(', ')}

Output JSON format:
{
  "name": string,
  "category": string (must be from available categories),
  "quantity": number,
  "rack": string,
  "status": string (must be from available statuses),
  "purchaseDate": string (ISO format)
}

Rules:
- Extract tool name from the text
- Choose the most appropriate category and status from the available lists
- Infer quantity and rack if mentioned
- Parse purchase date into ISO format
- Return ONLY valid JSON, no explanation

Tool Text: ${toolText}
`;

  const aiResponse = await ai.models.generateContent({
    model: MODEL,
    contents: systemPrompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string" },
          quantity: { type: "number" },
          rack: { type: "string" },
          status: { type: "string" },
          purchaseDate: { type: "string" }
        },
        required: ["name", "category", "quantity", "rack", "status", "purchaseDate"]
      }
    }
  });

  return JSON.parse(aiResponse.text);
}

module.exports = {
  ai,
  MODEL,
  generateSearchParams,
  generateTool
};
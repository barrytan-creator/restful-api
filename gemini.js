// gemini.js
require('dotenv').config(); // read the GEMINI_API_KEY and the GEMINI_MODEL from the .env file
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// generateSearchParams(query, categories, racks, statuses)
// Converts a natural language query into structured search params.
// Returns:
// {
//   toolNames: string[],
//   categories: string[],
//   racks: string[],
//   statuses: string[],
//   requestedParameters: string[]
// }
async function generateSearchParams(query, categories = [], racks = [], statuses = []) {
  const systemPrompt = `You are a search query converter for a Tool Manager Inventory system.
Convert the user's natural language query into a structured JSON format that helps the backend find the right tools and the specific parameters the user asks about.

Output: A JSON object with the following fields, ONLY using values from the available lists above and empty arrays if no values apply:
{
  "toolNames": string[],            // exact tool names from DB if the user mentions a specific tool
  "categories": string[],           // categories to filter by (OR logic)
  "racks": string[],                // racks to filter by (OR logic)
  "statuses": string[],             // statuses to filter by (OR logic)
  "requestedParameters": string[]   // parameters the user asks about (e.g., weight, size, model, brand, batteryCapacity)
}

Rules:
- Only use values from the provided lists when possible.
- If the user mentions a specific tool (e.g., "angle grinder", "cordless drill"), include it in toolNames.
- For requestedParameters, extract explicit parameter keywords from the query (e.g., weight, size, type, model, brand, voltage, batteryCapacity) and normalize common synonyms (e.g., "mass" -> "weight", "dimensions" -> "size").
- Return empty arrays if no values apply.
- Return ONLY valid JSON, no explanations, no code fences.
- Keep parameter names lowercase and normalized.
- Prefer exact tool names when mentioned; otherwise infer categories/racks/statuses.

Examples:
User: "what is the weight for angle grinder"
Output: {"toolNames":["Angle Grinder"],"categories":[],"racks":[],"statuses":[],"requestedParameters":["weight"]}

User: "show me list of hand tools"
Output: {"toolNames":[],"categories":["Hand Tools"],"racks":[],"statuses":[],"requestedParameters":[]}

User: "battery capacity and weight for cordless drill"
Output: {"toolNames":["Cordless Drill"],"categories":[],"racks":[],"statuses":[],"requestedParameters":["batteryCapacity","weight"]}

User: "list heavy duty tools in Workshop B"
Output: {"toolNames":[],"categories":["Hand Tools"],"racks":["Workshop B"],"statuses":["Available"],"requestedParameters":["type","weight"]}

User's query: ${query}
Available Categories: ${categories}
Available Racks: ${racks}
Available Statuses: ${statuses}
`;

  const aiResponse = await ai.models.generateContent({
    model: MODEL,
    contents: systemPrompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          toolNames: { type: "array", items: { type: "string" } },
          categories: { type: "array", items: { type: "string" } },
          racks: { type: "array", items: { type: "string" } },
          statuses: { type: "array", items: { type: "string" } },
          requestedParameters: { type: "array", items: { type: "string" } }
        },
        required: ["toolNames", "categories", "racks", "statuses", "requestedParameters"]
      }
    }
  });

  // Guard for different SDK response shapes
  const text = aiResponse && (aiResponse.text || aiResponse.outputText || aiResponse.output?.[0]?.content?.[0]?.text);
  if (!text) {
    console.error('generateSearchParams: AI response missing text field', aiResponse);
    throw new Error('AI response missing text');
  }

  const parsed = JSON.parse(text);
  return {
    toolNames: Array.isArray(parsed.toolNames) ? parsed.toolNames : [],
    categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    racks: Array.isArray(parsed.racks) ? parsed.racks : [],
    statuses: Array.isArray(parsed.statuses) ? parsed.statuses : [],
    requestedParameters: Array.isArray(parsed.requestedParameters) ? parsed.requestedParameters.map(p => p.toLowerCase()) : []
  };
}

// generateTool(toolText, availableCategories, availableStatuses)
// Parse a freeform tool description into a structured tool object.
async function generateTool(toolText, availableCategories = [], availableStatuses = []) {
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
  "purchaseDate": string (ISO format YYYY-MM-DD),
  "tags": string[]  // optional
}

Rules:
- Extract tool name from the text (use proper capitalization).
- Choose the most appropriate category and status from the available lists.
- Infer quantity and rack if mentioned.
- Parse purchase date into ISO format if present.
- Return ONLY valid JSON, no explanation.

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
          purchaseDate: { type: "string" },
          tags: { type: "array", items: { type: "string" } }
        },
        required: ["name", "category", "quantity", "rack", "status", "purchaseDate"]
      }
    }
  });

  const text = aiResponse && (aiResponse.text || aiResponse.outputText || aiResponse.output?.[0]?.content?.[0]?.text);
  if (!text) {
    console.error('generateTool: AI response missing text field', aiResponse);
    throw new Error('AI response missing text');
  }

  return JSON.parse(text);
}

module.exports = {
  ai,
  MODEL,
  generateSearchParams,
  generateTool
};
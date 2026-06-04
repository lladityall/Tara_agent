import * as dotenv from 'dotenv';
import { queryTransactions, portfolioAnalysis, TOOL_DEFINITIONS } from './tools';

dotenv.config();

const OLLAMA_BASE_URL = 'https://ollama.com';
const OLLAMA_MODEL = 'gpt-oss:120b';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';

export interface TraceEntry {
  timestamp: string;
  type: 'user' | 'llm_call' | 'tool_call' | 'tool_result' | 'final_answer' | 'error';
  content: string;
  latency_ms?: number;
  tool_name?: string;
  tool_params?: any;
}

export interface AgentResponse {
  answer: string;
  traces: TraceEntry[];
  total_latency_ms: number;
}

const SYSTEM_PROMPT = `You are Tara, an enterprise-grade financial intelligence assistant specializing in mutual fund portfolio analysis.

CRITICAL RULES:
1. NEVER perform arithmetic calculations yourself. Always delegate ALL math to tools.
2. Use query_transactions for any question about transactions, invested amounts, buy/sell history.
3. Use portfolio_analysis for current values, returns, gains, and portfolio composition.
4. Round all numbers to exactly 2 decimal places in your final answer.
5. Always present amounts in Indian Rupees (₹) format with commas (e.g., ₹1,23,456.78).
6. For return percentages, always state both absolute return (₹ gain) and percentage return.
7. Differentiate clearly: "fund period return" = NAV change over time; "your return" = based on your purchase price.
8. If asked about net invested amount, use aggregate: "net_amount" which handles BUY - SELL correctly.

RESPONSE FORMAT:
- Start with a direct answer to the question
- Present key numbers prominently
- Provide brief context/insight
- Use bullet points for multi-fund comparisons
- End with a relevant observation or suggestion

You represent precision, trust, and financial clarity.`;

async function callOllamaAPI(messages: any[], tools?: any[]): Promise<any> {
  const body: any = {
    model: OLLAMA_MODEL,
    messages,
    stream: false,
    options: {
      temperature: 0.1,
      num_predict: 2048,
    },
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OLLAMA_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama API error ${response.status}: ${errText}`);
  }

  return response.json();
}

async function executeTool(toolName: string, toolArgs: any): Promise<any> {
  if (toolName === 'query_transactions') {
    return queryTransactions(toolArgs);
  } else if (toolName === 'portfolio_analysis') {
    return portfolioAnalysis(toolArgs);
  }
  return { success: false, error: `Unknown tool: ${toolName}` };
}

export async function askTara(userQuestion: string): Promise<AgentResponse> {
  const traces: TraceEntry[] = [];
  const startTime = Date.now();

  traces.push({
    timestamp: new Date().toISOString(),
    type: 'user',
    content: userQuestion,
  });

  const messages: any[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userQuestion },
  ];

  let finalAnswer = '';
  let iterationCount = 0;
  const MAX_ITERATIONS = 6;

  while (iterationCount < MAX_ITERATIONS) {
    iterationCount++;
    const llmStart = Date.now();

    let llmResponse: any;
    try {
      llmResponse = await callOllamaAPI(messages, TOOL_DEFINITIONS);
    } catch (err: any) {
      traces.push({
        timestamp: new Date().toISOString(),
        type: 'error',
        content: `LLM call failed: ${err.message}`,
        latency_ms: Date.now() - llmStart,
      });
      finalAnswer = `I encountered an error connecting to the AI service: ${err.message}`;
      break;
    }

    const llmLatency = Date.now() - llmStart;
    const message = llmResponse.message || llmResponse.choices?.[0]?.message;

    if (!message) {
      finalAnswer = 'No response from model.';
      break;
    }

    traces.push({
      timestamp: new Date().toISOString(),
      type: 'llm_call',
      content: message.content || '(tool calls only)',
      latency_ms: llmLatency,
    });

    // Check for tool calls
    const toolCalls = message.tool_calls || [];

    if (toolCalls.length === 0) {
      // No more tool calls — this is the final answer
      finalAnswer = message.content || '';
      traces.push({
        timestamp: new Date().toISOString(),
        type: 'final_answer',
        content: finalAnswer,
        latency_ms: Date.now() - startTime,
      });
      break;
    }

    // Execute all tool calls
    messages.push({ role: 'assistant', content: message.content || '', tool_calls: toolCalls });

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function?.name || toolCall.name;
      const toolArgs =
        typeof toolCall.function?.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function?.arguments || toolCall.arguments || {};

      const toolStart = Date.now();

      traces.push({
        timestamp: new Date().toISOString(),
        type: 'tool_call',
        content: `Calling ${toolName}`,
        tool_name: toolName,
        tool_params: toolArgs,
      });

      const toolResult = await executeTool(toolName, toolArgs);
      const toolLatency = Date.now() - toolStart;

      traces.push({
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        content: JSON.stringify(toolResult).substring(0, 500),
        tool_name: toolName,
        latency_ms: toolLatency,
      });

      // Add tool result to message history
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id || `call_${toolName}`,
        name: toolName,
        content: JSON.stringify(toolResult),
      });
    }
  }

  if (!finalAnswer) {
    finalAnswer = 'I was unable to generate a complete response. Please try rephrasing your question.';
  }

  return {
    answer: finalAnswer,
    traces,
    total_latency_ms: Date.now() - startTime,
  };
}

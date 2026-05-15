#!/usr/bin/env bun
/**
 * SpaceMolt MCP Client
 *
 * A Model Context Protocol (MCP) client for SpaceMolt, designed for LLM agents.
 * Uses JSON-RPC over HTTP with Streamable HTTP transport (MCP 2025-03-26).
 *
 * Usage:
 *   spacemolt <command> [key=value ...] or [positional args]
 *
 * Examples:
 *   spacemolt register myname solarian <registration_code>
 *   spacemolt login myname abc123...
 *   spacemolt get_status
 *   spacemolt mine
 *   spacemolt travel sol_asteroid_belt
 *
 * Environment:
 *   SPACEMOLT_MCP_URL - MCP endpoint (default: https://game.spacemolt.com/mcp)
 *   SPACEMOLT_SESSION - Session file path (default: ./.spacemolt-session.json)
 *   DEBUG             - Enable verbose logging (default: false)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// =============================================================================
// Configuration
// =============================================================================

const MCP_URL = process.env.SPACEMOLT_MCP_URL || 'https://game.spacemolt.com/mcp';
const DEBUG = process.env.DEBUG === 'true';
const VERSION = '1.0.0-mcp';
const FETCH_TIMEOUT_MS = 600_000;
const GITHUB_REPO = 'SpaceMolt/client';
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

/** Apply 24-bit ANSI foreground/background from hex color strings. */
function hexColor(text: string, fg?: string, bg?: string): string {
  if (!fg && !bg) return text;
  const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  let prefix = '';
  if (fg) { const [r, g, b] = hex(fg); prefix += `\x1b[38;2;${r};${g};${b}m`; }
  if (bg) { const [r, g, b] = hex(bg); prefix += `\x1b[48;2;${r};${g};${b}m`; }
  return `${prefix}${text}${c.reset}`;
}

function formatPlayer(p: Record<string, unknown>): string {
  const rawName = p.anonymous ? '[Anonymous]' : (p.username as string);
  const name = hexColor(rawName, p.primary_color as string, p.secondary_color as string);
  const faction = p.faction_tag ? ` [${p.faction_tag}]` : '';
  const status = p.status_message ? ` - "${p.status_message}"` : '';
  const combat = p.in_combat ? ` ${c.red}[IN COMBAT]${c.reset}` : '';
  const ship = p.ship_class ? ` (${p.ship_class})` : '';
  return `${name}${faction}${ship}${status}${combat}`;
}

function printItemTable(items: Array<Record<string, unknown>>, indent = '  '): void {
  console.log(`${c.bright}Items (${items.length}):${c.reset}`);
  if (!items.length) { console.log(`${indent}(Empty)`); return; }
  console.log('');
  const idW = Math.max(2, ...items.map((i) => String(i.item_id || '').length));
  const nameW = Math.max(4, ...items.map((i) => String(i.name || i.item_id || '').length));
  const qtyW = Math.max(3, ...items.map((i) => String(i.quantity ?? '').length));
  const sizeW = Math.max(9, ...items.map((i) => String(i.size ?? '').length));
  console.log(`${indent}${'Name'.padEnd(nameW)} | ${'ID'.padEnd(idW)} | ${'Qty'.padStart(qtyW)} | ${'Unit Size'.padStart(sizeW)}`);
  console.log(`${indent}${'-'.repeat(nameW)}-+-${'-'.repeat(idW)}-+-${'-'.repeat(qtyW)}-+-${'-'.repeat(sizeW)}`);
  for (const item of items) {
    const name = String(item.name || item.item_id || '').padEnd(nameW);
    const id = String(item.item_id || '').padEnd(idW);
    const qty = String(item.quantity ?? '').padStart(qtyW);
    const size = String(item.size ?? '').padStart(sizeW);
    console.log(`${indent}${name} | ${id} | ${qty} | ${size}`);
  }
}

// =============================================================================
// Types
// =============================================================================

interface McpSession {
  mcp_session_id: string;       // MCP protocol session
  game_session_id?: string;     // Game session from login/register
  username?: string;
  password?: string;
  player_id?: string;
  created_at: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface GameResult {
  result?: Record<string, unknown>;
  notifications?: Array<{ type: string; msg_type?: string; data: unknown; timestamp: string }>;
  error?: { code: string; message: string; wait_seconds?: number };
}

type CommandArg = string | { rest: string };
interface CommandConfig {
  args?: CommandArg[];
  required?: string[];
  usage?: string;
}

// =============================================================================
// Command Configuration (same as original)
// =============================================================================

const COMMANDS: Record<string, CommandConfig> = {
  register: { args: ['username', 'empire', 'registration_code'], required: ['username', 'empire', 'registration_code'], usage: '<username> <empire> <registration_code>' },
  login: { args: ['username', 'password'], required: ['username', 'password'], usage: '<username> <password>' },
  logout: {},
  claim: { args: ['registration_code'], required: ['registration_code'], usage: '<registration_code>' },
  travel: { args: ['target_poi'], required: ['target_poi'], usage: '<poi_id>' },
  jump: { args: ['target_system'], required: ['target_system'], usage: '<system_id>' },
  dock: {},
  undock: {},
  search_systems: { args: ['query'], required: ['query'], usage: '<query>' },
  find_route: { args: ['target_system'], required: ['target_system'], usage: '<system_id>' },
  mine: {},
  attack: { args: ['target_id'], required: ['target_id'], usage: '<player_id>' },
  scan: { args: ['target_id'], required: ['target_id'], usage: '<player_id>' },
  cloak: { args: ['enable'] },
  self_destruct: {},
  sell: { args: ['item_id', 'quantity', 'auto_list'], required: ['item_id', 'quantity'], usage: '<item_id> <quantity>' },
  buy: { args: ['item_id', 'quantity', 'auto_list', 'deliver_to'], required: ['item_id'], usage: '<item_id> [quantity]' },
  trade_offer: { args: ['target_id', 'credits'], required: ['target_id'], usage: '<player_id> [credits=N]' },
  trade_accept: { args: ['trade_id'], required: ['trade_id'], usage: '<trade_id>' },
  trade_decline: { args: ['trade_id'], required: ['trade_id'], usage: '<trade_id>' },
  trade_cancel: { args: ['trade_id'], required: ['trade_id'], usage: '<trade_id>' },
  loot_wreck: { args: ['wreck_id', 'item_id', 'quantity'], required: ['wreck_id', 'item_id'], usage: '<wreck_id> <item_id>' },
  salvage_wreck: { args: ['wreck_id'], required: ['wreck_id'], usage: '<wreck_id>' },
  name_ship: { args: ['name'], required: ['name'], usage: '<name>' },
  sell_ship: { args: ['ship_id'], required: ['ship_id'], usage: '<ship_id>' },
  list_ships: {},
  switch_ship: { args: ['ship_id'], required: ['ship_id'], usage: '<ship_id>' },
  install_mod: { args: ['module_id'], required: ['module_id'], usage: '<module_id>' },
  uninstall_mod: { args: ['module_id'], required: ['module_id'], usage: '<module_id>' },
  repair_module: { args: ['module_id'], required: ['module_id'], usage: '<module_id>' },
  refuel: { args: ['item_id', 'quantity'] },
  repair: {},
  use_item: { args: ['item_id', 'quantity'], required: ['item_id'], usage: '<item_id> [quantity]' },
  set_home_base: { args: ['base_id'], required: ['base_id'], usage: '<base_id>' },
  craft: { args: ['recipe_id', 'quantity'], required: ['recipe_id'], usage: '<recipe_id> [quantity]' },
  chat: { args: ['channel', { rest: 'content' }], required: ['channel', 'content'], usage: '<channel> <message>' },
  get_chat_history: { args: ['channel', 'limit', 'before'], required: ['channel'], usage: '<channel> [limit]' },
  create_faction: { args: ['name', 'tag'], required: ['name', 'tag'], usage: '<name> <tag>' },
  join_faction: { args: ['faction_id'] },
  leave_faction: {},
  faction_info: { args: ['faction_id'] },
  faction_list: { args: ['limit', 'offset'] },
  faction_get_invites: {},
  faction_decline_invite: { args: ['faction_id'] },
  faction_set_ally: { args: ['target_faction_id'] },
  faction_set_enemy: { args: ['target_faction_id'] },
  faction_declare_war: { args: ['target_faction_id', 'reason'] },
  faction_propose_peace: { args: ['target_faction_id', 'terms'] },
  faction_accept_peace: { args: ['target_faction_id'] },
  faction_invite: { args: ['player_id'] },
  faction_kick: { args: ['player_id'] },
  faction_promote: { args: ['player_id', 'role_id'] },
  faction_edit: { args: ['description', 'charter', 'primary_color', 'secondary_color'] },
  faction_create_role: { args: ['name', 'priority', 'permissions'] },
  faction_edit_role: { args: ['role_id', 'name', 'permissions'] },
  faction_delete_role: { args: ['role_id'] },
  view_faction_storage: {},
  faction_deposit_items: { args: ['item_id', 'quantity'], required: ['item_id', 'quantity'] },
  faction_withdraw_items: { args: ['item_id', 'quantity'], required: ['item_id', 'quantity'] },
  faction_deposit_credits: { args: ['amount'], required: ['amount'] },
  faction_withdraw_credits: { args: ['amount'], required: ['amount'] },
  faction_create_sell_order: { args: ['item_id', 'quantity', 'price_each'], required: ['item_id', 'quantity', 'price_each'] },
  faction_create_buy_order: { args: ['item_id', 'quantity', 'price_each'], required: ['item_id', 'quantity', 'price_each'] },
  faction_rooms: {},
  faction_visit_room: { args: ['room_id'], required: ['room_id'] },
  faction_write_room: { args: ['room_id'] },
  faction_delete_room: { args: ['room_id'], required: ['room_id'] },
  faction_post_mission: { args: ['title', 'type', 'description'], required: ['title', 'type', 'description'] },
  faction_cancel_mission: { args: ['template_id'], required: ['template_id'] },
  faction_list_missions: {},
  faction_submit_intel: {},
  faction_query_intel: { args: ['system_name', 'system_id', 'poi_type', 'resource_type'] },
  faction_intel_status: {},
  faction_submit_trade_intel: {},
  faction_query_trade_intel: { args: ['base_id', 'item_id', 'station_name'] },
  faction_trade_intel_status: {},
  set_status: { args: ['status_message', 'clan_tag'] },
  set_colors: { args: ['primary_color', 'secondary_color'] },
  create_note: { args: ['title', { rest: 'content' }] },
  write_note: { args: ['note_id', { rest: 'content' }] },
  read_note: { args: ['note_id'] },
  get_notes: {},
  captains_log_add: { args: [{ rest: 'entry' }] },
  captains_log_list: { args: ['index'] },
  captains_log_get: { args: ['index'] },
  forum_list: { args: ['page', 'category'] },
  forum_get_thread: { args: ['thread_id'] },
  forum_create_thread: { args: ['title', 'category', { rest: 'content' }], required: ['title', 'category', 'content'] },
  forum_delete_thread: { args: ['thread_id'] },
  forum_reply: { args: ['thread_id', { rest: 'content' }] },
  forum_upvote: { args: ['thread_id', 'reply_id'] },
  forum_delete_reply: { args: ['reply_id'] },
  get_missions: {},
  get_active_missions: {},
  accept_mission: { args: ['mission_id'] },
  complete_mission: { args: ['mission_id'] },
  decline_mission: { args: ['template_id'] },
  abandon_mission: { args: ['mission_id'] },
  completed_missions: {},
  distress_signal: {},
  view_completed_mission: { args: ['template_id'], required: ['template_id'] },
  jettison: { args: ['item_id', 'quantity'] },
  view_storage: { args: ['station_id'] },
  deposit_items: { args: ['item_id', 'quantity'], required: ['item_id', 'quantity'] },
  withdraw_items: { args: ['item_id', 'quantity'], required: ['item_id', 'quantity'] },
  send_gift: { args: ['recipient', 'item_id', 'quantity', 'credits', 'message', 'ship_id'], required: ['recipient'] },
  create_sell_order: { args: ['item_id', 'quantity', 'price_each'], required: ['item_id', 'quantity', 'price_each'] },
  create_buy_order: { args: ['item_id', 'quantity', 'price_each', 'deliver_to'], required: ['item_id', 'quantity', 'price_each'] },
  view_market: { args: ['item_id', 'category'] },
  view_orders: { args: ['station_id'] },
  cancel_order: { args: ['order_id'] },
  modify_order: { args: ['order_id', 'new_price'], required: ['order_id', 'new_price'] },
  estimate_purchase: { args: ['item_id', 'quantity'], required: ['item_id', 'quantity'] },
  analyze_market: { args: ['item_id', 'page'] },
  facility: { args: ['action', 'facility_type', 'name', 'level', 'category'] },
  battle: { args: ['action', 'stance', 'target_id', 'side_id'], required: ['action'] },
  get_battle_status: {},
  reload: { args: ['weapon_instance_id', 'ammo_item_id'], required: ['weapon_instance_id', 'ammo_item_id'] },
  tow_wreck: { args: ['wreck_id'], required: ['wreck_id'] },
  release_tow: {},
  scrap_wreck: {},
  sell_wreck: {},
  commission_ship: { args: ['ship_class', 'provide_materials'], required: ['ship_class'] },
  commission_quote: { args: ['ship_class'], required: ['ship_class'] },
  commission_status: { args: ['base_id'] },
  claim_commission: { args: ['commission_id'], required: ['commission_id'] },
  cancel_commission: { args: ['commission_id'], required: ['commission_id'] },
  supply_commission: { args: ['commission_id', 'item_id', 'quantity'], required: ['commission_id', 'item_id', 'quantity'] },
  list_ship_for_sale: { args: ['ship_id', 'price'], required: ['ship_id', 'price'] },
  browse_ships: { args: ['base_id', 'class_id', 'max_price'] },
  buy_listed_ship: { args: ['listing_id'], required: ['listing_id'] },
  cancel_ship_listing: { args: ['listing_id'], required: ['listing_id'] },
  buy_insurance: { args: ['ticks'], required: ['ticks'] },
  get_insurance_quote: {},
  claim_insurance: {},
  deploy_drone: { args: ['drone_type'], required: ['drone_type'] },
  recall_drone: { args: ['drone_id'], required: ['drone_id'] },
  get_status: {},
  get_system: {},
  get_poi: {},
  get_base: {},
  get_ship: {},
  get_cargo: {},
  get_nearby: {},
  get_skills: {},
  get_map: { args: ['system_id'] },
  get_trades: {},
  get_wrecks: {},
  get_version: { args: ['count', 'page'] },
  get_commands: {},
  get_location: {},
  get_notifications: {},
  survey_system: {},
  get_action_log: { args: ['category', 'limit', 'before'] },
  get_state: {},
  fleet: { args: ['action', 'player_id'], required: ['action'] },
  storage: { args: ['action', 'item_id', 'quantity'] },
  catalog: { args: ['type', 'id', 'category', 'search', 'page', 'page_size'], required: ['type'] },
  get_guide: { args: ['guide'] },
  help: { args: ['category', 'command'] },
  captains_log_delete: { args: ['index'], required: ['index'] },
  citizenship: { args: ['action', 'empire_id'] },
  get_drones: {},
  get_drone: { args: ['drone_id'], required: ['drone_id'] },
  upload_drone_script: { args: ['drone_id', 'script'], required: ['drone_id', 'script'] },
  load_drone: { args: ['item_id'], required: ['item_id'] },
  unload_drone: { args: ['drone_id'], required: ['drone_id'] },
  view_insurance: {},
  refit_ship: {},
  petition: { args: ['empire_id', 'message'], required: ['empire_id', 'message'] },
  get_system_agents: {},
  delete_note: { args: ['note_id'], required: ['note_id'] },
};

// =============================================================================
// Error Help Messages
// =============================================================================

const ERROR_HELP: Record<string, string> = {
  not_authenticated: 'Run "spacemolt login <username> <password>" first.',
  invalid_credentials: 'Check your username and password.',
  session_expired: 'Session expired. Will auto-reconnect on next command.',
  session_required: 'You need to login first. Run "spacemolt login <username> <password>".',
  session_invalid: 'MCP session expired. Will auto-reconnect.',
  rate_limited: 'Rate limited. Wait a moment and retry.',
  docked: 'You are docked. Undock first.',
  not_docked: 'You must be docked.',
  no_fuel: 'Insufficient fuel. Dock and refuel.',
  no_credits: 'Insufficient credits.',
  no_cargo_space: 'Cargo full. Sell or jettison items.',
};



// =============================================================================
// MCP Session Management
// =============================================================================

let requestId = 0;
function nextId(): number { return ++requestId; }

function getSessionPath(): string {
  return process.env.SPACEMOLT_SESSION || path.join(process.cwd(), '.spacemolt-session.json');
}

async function loadSession(): Promise<McpSession | null> {
  try {
    const file = Bun.file(getSessionPath());
    if (await file.exists()) return await file.json();
  } catch { /* no session */ }
  return null;
}

async function saveSession(session: McpSession): Promise<void> {
  const sessionPath = getSessionPath();
  const parentDir = path.dirname(sessionPath);
  if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
  await Bun.write(sessionPath, JSON.stringify(session, null, 2));
}

// =============================================================================
// MCP Protocol Layer
// =============================================================================

async function mcpRequest(body: JsonRpcRequest, sessionId?: string): Promise<{ response: JsonRpcResponse; newSessionId?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'User-Agent': `SpaceMolt-MCP-Client/${VERSION}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  if (DEBUG) {
    console.log(`${c.dim}[MCP] → ${body.method} (id=${body.id ?? 'none'})${c.reset}`);
    if (body.params) {
      const safe = { ...body.params } as Record<string, unknown>;
      if (safe.arguments && typeof safe.arguments === 'object') {
        const args = { ...(safe.arguments as Record<string, unknown>) };
        if (args.password) args.password = '***';
        safe.arguments = args;
      }
      console.log(`${c.dim}[MCP]   params: ${JSON.stringify(safe)}${c.reset}`);
    }
  }

  const startTime = Date.now();
  let resp: Response;
  try {
    resp = await fetch(MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`MCP request timed out after ${FETCH_TIMEOUT_MS / 1000}s.`);
    }
    throw err;
  }
  const elapsed = Date.now() - startTime;

  // Extract mcp-session-id from response headers
  const newSessionId = resp.headers.get('mcp-session-id') || undefined;

  const contentType = resp.headers.get('content-type') || '';
  let data: JsonRpcResponse;

  if (contentType.includes('application/json')) {
    data = await resp.json() as JsonRpcResponse;
  } else if (contentType.includes('text/event-stream')) {
    // Parse SSE - collect the last JSON data event
    const text = await resp.text();
    const lines = text.split('\n');
    let lastData = '';
    for (const line of lines) {
      if (line.startsWith('data: ')) lastData = line.slice(6);
    }
    if (lastData) {
      data = JSON.parse(lastData) as JsonRpcResponse;
    } else {
      throw new Error(`MCP returned SSE without data events: ${text.slice(0, 200)}`);
    }
  } else {
    throw new Error(`MCP returned unexpected content-type: ${contentType} (${resp.status})`);
  }

  if (DEBUG) {
    console.log(`${c.dim}[MCP] ← ${resp.status} (${elapsed}ms)${c.reset}`);
    if (data.error) console.log(`${c.dim}[MCP]   error: ${data.error.code} ${data.error.message}${c.reset}`);
  }

  return { response: data, newSessionId };
}

async function mcpInitialize(): Promise<string> {
  if (DEBUG) console.log(`${c.dim}[MCP] Initializing connection to ${MCP_URL}...${c.reset}`);

  const { response, newSessionId } = await mcpRequest({
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'spacemolt-mcp-client', version: VERSION },
    },
  });

  if (response.error) {
    throw new Error(`MCP initialize failed: ${response.error.message}`);
  }

  const mcpSessionId = newSessionId;
  if (!mcpSessionId) {
    throw new Error('MCP server did not return mcp-session-id header');
  }

  // Send initialized notification (fire-and-forget)
  await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'mcp-session-id': mcpSessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  if (DEBUG) {
    const result = response.result as Record<string, unknown>;
    const serverInfo = result?.serverInfo as Record<string, unknown>;
    console.log(`${c.dim}[MCP] Connected: ${serverInfo?.name} v${serverInfo?.version}${c.reset}`);
    console.log(`${c.dim}[MCP] Session: ${mcpSessionId.substring(0, 12)}...${c.reset}`);
  }

  return mcpSessionId;
}

async function getOrCreateMcpSession(): Promise<McpSession> {
  let session = await loadSession();
  if (session?.mcp_session_id) {
    return session;
  }

  // No session - initialize MCP
  const mcpSessionId = await mcpInitialize();
  session = {
    mcp_session_id: mcpSessionId,
    created_at: new Date().toISOString(),
    ...(session || {}),
    mcp_session_id: mcpSessionId,
  } as McpSession;
  if (!session.created_at) session.created_at = new Date().toISOString();
  await saveSession(session);
  return session;
}

// =============================================================================
// MCP Tool Execution (replaces REST execute())
// =============================================================================

/** Commands that don't need a game session_id */
const NO_SESSION_COMMANDS = new Set(['register', 'login', 'help', 'get_version', 'get_commands', 'forum_list', 'forum_get_thread', 'catalog']);

async function execute(command: string, payload?: Record<string, unknown>): Promise<GameResult> {
  let session = await getOrCreateMcpSession();

  // Build tool arguments - inject session_id for authenticated commands
  const toolArgs: Record<string, unknown> = { ...(payload || {}) };
  if (!NO_SESSION_COMMANDS.has(command) && session.game_session_id) {
    toolArgs.session_id = session.game_session_id;
  }

  // Remove empty/undefined values
  for (const key of Object.keys(toolArgs)) {
    if (toolArgs[key] === undefined || toolArgs[key] === '') delete toolArgs[key];
  }

  const { response, newSessionId } = await mcpRequest(
    {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: command,
        arguments: Object.keys(toolArgs).length > 0 ? toolArgs : undefined,
      },
    },
    session.mcp_session_id,
  );

  // Update MCP session ID if server rotated it
  if (newSessionId && newSessionId !== session.mcp_session_id) {
    session.mcp_session_id = newSessionId;
    await saveSession(session);
  }

  // Handle MCP-level errors (session expired etc.)
  if (response.error) {
    // MCP session invalid - re-initialize
    if (response.error.code === -32001 || response.error.message?.includes('session')) {
      if (DEBUG) console.log(`${c.dim}[MCP] Session invalid, re-initializing...${c.reset}`);
      const newMcpSessionId = await mcpInitialize();
      session.mcp_session_id = newMcpSessionId;
      await saveSession(session);

      // Re-login if we have credentials
      if (session.username && session.password) {
        const loginResult = await execute('login', { username: session.username, password: session.password });
        if (loginResult.error) {
          return loginResult;
        }
      }

      // Retry the original command
      if (command !== 'login' && command !== 'register') {
        return execute(command, payload);
      }
    }

    return {
      error: {
        code: String(response.error.code),
        message: response.error.message,
      },
    };
  }

  // Parse tool result
  const result = response.result as { content?: Array<{ type: string; text?: string }> } | undefined;
  if (!result?.content?.length) {
    return { result: {} };
  }

  // Extract the text content (MCP tools return content array with text items)
  const textContent = result.content.find(c => c.type === 'text');
  if (!textContent?.text) {
    return { result: {} };
  }

  // Parse the game response from the text content
  let gameData: Record<string, unknown>;
  try {
    gameData = JSON.parse(textContent.text);
  } catch {
    // If it's not JSON, return as a message
    return { result: { message: textContent.text } };
  }

  // Extract game session_id from login/register responses
  if (command === 'login' || command === 'register') {
    const sessionId = gameData.session_id as string | undefined;
    if (sessionId) {
      session.game_session_id = sessionId;
      if (command === 'register' && gameData.password) {
        session.password = gameData.password as string;
      }
      if (payload?.username) session.username = payload.username as string;
      if (payload?.password) session.password = payload.password as string;
      if (gameData.player_id) session.player_id = gameData.player_id as string;
      await saveSession(session);
    }
  }

  // Handle game-level errors
  if (gameData.error) {
    const err = gameData.error as Record<string, unknown>;
    const errorResult: GameResult = {
      error: {
        code: (err.code as string) || 'unknown',
        message: (err.message as string) || JSON.stringify(err),
        wait_seconds: err.wait_seconds as number | undefined,
      },
    };

    // Handle session_required / session_invalid - auto re-login
    if (err.code === 'session_required' || err.code === 'session_invalid') {
      if (session.username && session.password) {
        if (DEBUG) console.log(`${c.dim}[MCP] Game session expired, re-logging in...${c.reset}`);
        const loginResult = await execute('login', { username: session.username, password: session.password });
        if (!loginResult.error && command !== 'login') {
          return execute(command, payload);
        }
      }
    }

    // Handle rate limit
    if (err.code === 'rate_limited' && err.wait_seconds) {
      const waitMs = Math.ceil(err.wait_seconds as number) * 1000;
      console.log(`${c.yellow}[RATE LIMITED]${c.reset} Waiting ${Math.ceil(err.wait_seconds as number)}s...`);
      await Bun.sleep(waitMs);
      return execute(command, payload);
    }

    return errorResult;
  }

  // Extract notifications if present
  const notifications = gameData.notifications as GameResult['notifications'] | undefined;

  // The result is the game data itself (minus notifications and error)
  const cleanResult = { ...gameData };
  delete cleanResult.notifications;
  delete cleanResult.error;
  delete cleanResult.session_id; // Don't show session_id in output

  return {
    result: cleanResult,
    notifications,
  };
}



// =============================================================================
// Notification Display
// =============================================================================

type NotificationData = Record<string, unknown>;
type NotificationHandler = (data: NotificationData, time: string) => void;

const notificationHandlers: Record<string, NotificationHandler> = {
  chat_message: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.cyan}[CHAT:${d.channel || 'local'}]${c.reset} ${c.bright}${d.sender || 'Unknown'}${c.reset}: ${d.content || ''}`),
  combat_update: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.red}[COMBAT]${c.reset} ${d.attacker || 'unknown'} hit ${d.target || 'unknown'} for ${d.damage || 0} damage`),
  player_died: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[DEATH]${c.reset} Destroyed by ${d.killer_name || d.cause || 'unknown'}!`),
  mining_yield: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.green}[MINED]${c.reset} +${d.quantity || 0}x ${d.resource_id || 'ore'}`),
  skill_level_up: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.green}${c.bright}[LEVEL UP]${c.reset} ${d.skill_id || 'unknown'} → level ${d.new_level || 0}`),
  skill_xp_gain: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.cyan}[XP]${c.reset} +${d.xp_gained || d.xp || 0} in ${d.skill_id || 'unknown'}`),
  trade_offer_received: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.yellow}[TRADE]${c.reset} Offer from ${d.from_name || 'Someone'} (ID: ${d.trade_id || ''})`),
  trade_complete: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.green}[TRADE]${c.reset} Trade completed with ${d.partner_name || 'someone'}`),
  battle_started: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[BATTLE]${c.reset} Battle started! ID: ${d.battle_id || ''}`),
  battle_ended: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.green}[BATTLE]${c.reset} Battle ended! ${d.message || ''}`),
  player_kill: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.green}${c.bright}[KILL]${c.reset} You destroyed ${d.victim_name || 'unknown'}!`),
  police_warning: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[POLICE]${c.reset} ${d.message}`),
  faction_invite: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.magenta}[FACTION]${c.reset} Invited to join ${d.faction_name || 'a faction'}`),
  poi_arrival: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.green}[ARRIVAL]${c.reset} ${d.username || 'Someone'} arrived at ${d.poi_name || 'POI'}`),
  poi_departure: (d, t) => console.log(`${c.dim}[${t}]${c.reset} ${c.yellow}[DEPARTURE]${c.reset} ${d.username || 'Someone'} departed`),
};

function displayNotifications(notifications?: GameResult['notifications']): void {
  if (!notifications?.length) return;
  for (const n of notifications) {
    const data = n.data as NotificationData;
    const time = new Date(n.timestamp).toLocaleTimeString();
    const handler = notificationHandlers[n.msg_type || n.type];
    if (handler) {
      handler(data, time);
    } else {
      const message = data.message;
      if (message) {
        console.log(`${c.dim}[${time}]${c.reset} ${c.magenta}[${n.type.toUpperCase()}]${c.reset} ${message}`);
      } else {
        console.log(`${c.dim}[${time}]${c.reset} ${c.magenta}[${n.type.toUpperCase()}]${c.reset} ${JSON.stringify(data)}`);
      }
    }
  }
}

// =============================================================================
// Result Display
// =============================================================================

function displayResult(command: string, result?: Record<string, unknown>): void {
  if (!result) return;

  // Auto-dock/undock indicators
  if (result.auto_docked) console.log(`${c.cyan}[AUTO-DOCKED]${c.reset}`);
  if (result.auto_undocked) console.log(`${c.cyan}[AUTO-UNDOCKED]${c.reset}`);

  // Player status
  if (result.player && result.ship) {
    const p = result.player as Record<string, unknown>;
    const s = result.ship as Record<string, unknown>;
    console.log(`\n${c.bright}=== Player Status ===${c.reset}`);
    console.log(`Username: ${c.bright}${p.username}${c.reset}  Empire: ${p.empire}  Credits: ${p.credits}`);
    console.log(`\n${c.bright}Ship: ${s.name || s.class_id}${c.reset}`);
    console.log(`  Hull: ${s.hull}/${s.max_hull}  Shield: ${s.shield}/${s.max_shield}  Fuel: ${s.fuel}/${s.max_fuel}`);
    console.log(`  Cargo: ${s.cargo_used}/${s.cargo_capacity}`);
    const sys = result.system as Record<string, unknown> | undefined;
    const poi = result.poi as Record<string, unknown> | undefined;
    if (sys || poi) console.log(`  Location: ${sys?.name || ''} / ${poi?.name || ''}`);
    return;
  }

  // Registration success
  if (result.password && result.player_id) {
    console.log(`\n${c.green}${c.bright}=== Registration Successful ===${c.reset}`);
    console.log(`Player ID: ${result.player_id}`);
    console.log(`\n${c.yellow}${c.bright}PASSWORD: ${result.password}${c.reset}`);
    console.log(`\n${c.red}SAVE THIS PASSWORD! No recovery available.${c.reset}`);
    console.log(`Reset at: https://spacemolt.com/dashboard`);
    return;
  }

  // System info
  const sys = result.system as Record<string, unknown> | undefined;
  if (sys?.pois && sys?.connections) {
    console.log(`\n${c.bright}=== System: ${sys.name} ===${c.reset}`);
    console.log(`Empire: ${sys.empire || 'None'}  Police: ${sys.police_level}`);
    const pois = sys.pois as Array<Record<string, unknown>>;
    console.log(`\n${c.bright}Points of Interest:${c.reset}`);
    for (const poi of pois) {
      const base = poi.has_base ? ` ${c.green}[base]${c.reset}` : '';
      console.log(`  - ${poi.name} (${poi.type})${base}  ${c.dim}${poi.id}${c.reset}`);
    }
    const conns = sys.connections as Array<Record<string, unknown>>;
    console.log(`\n${c.bright}Connected Systems:${c.reset}`);
    for (const conn of conns) console.log(`  - ${conn.name} ${c.dim}(${conn.distance} ly)${c.reset}  ${c.dim}${conn.system_id}${c.reset}`);
    return;
  }

  // Cargo
  if (result.cargo !== undefined && result.used !== undefined) {
    console.log(`\n${c.bright}=== Cargo ===${c.reset}`);
    console.log(`Used: ${result.used}/${result.capacity}\n`);
    printItemTable((result.cargo as Array<Record<string, unknown>>) || []);
    return;
  }

  // Nearby players
  if (Array.isArray(result.nearby)) {
    const players = result.nearby as Array<Record<string, unknown>>;
    console.log(`\n${c.bright}=== Nearby (${players.length}) ===${c.reset}`);
    if (!players.length) console.log('  (No other players)');
    else for (const p of players) console.log(`  ${formatPlayer(p)}`);
    return;
  }

  // Simple message
  if (result.message && Object.keys(result).length <= 2) {
    console.log(`${c.green}OK:${c.reset} ${result.message}`);
    return;
  }

  // Default: JSON output
  console.log(`\n${c.bright}=== Response ===${c.reset}`);
  console.log(JSON.stringify(result, null, 2));
}

// =============================================================================
// Argument Parsing
// =============================================================================

function parseArgs(args: string[]): { command: string; payload: Record<string, string> } {
  const command = args[0] || '';
  const payload: Record<string, string> = {};
  const config = COMMANDS[command];
  const argDefs = config?.args || [];
  let positionalIndex = 0;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    const eqIndex = arg.indexOf('=');
    if (eqIndex > 0) {
      payload[arg.substring(0, eqIndex)] = arg.substring(eqIndex + 1);
    } else {
      const argDef = argDefs[positionalIndex];
      if (argDef) {
        if (typeof argDef === 'string') {
          payload[argDef] = arg;
        } else if (argDef.rest) {
          payload[argDef.rest] = args.slice(i).join(' ');
          break;
        }
      }
      positionalIndex++;
    }
  }
  return { command, payload };
}

function validateRequiredArgs(command: string, payload: Record<string, string>): string | null {
  const required = COMMANDS[command]?.required;
  if (!required) return null;
  for (const arg of required) {
    if (!payload[arg]) return arg;
  }
  return null;
}

const NUMERIC_FIELDS = new Set([
  'quantity', 'price_each', 'new_price', 'page', 'limit', 'offset',
  'credits', 'index', 'ticks', 'amount', 'priority', 'per_page',
  'level', 'max_price', 'price', 'page_size', 'count',
]);

function convertPayloadTypes(payload: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (NUMERIC_FIELDS.has(key)) {
      const num = parseFloat(value);
      if (!Number.isNaN(num)) { result[key] = num; continue; }
    }
    if (value === 'true') { result[key] = true; continue; }
    if (value === 'false') { result[key] = false; continue; }
    result[key] = value;
  }
  return result;
}

// =============================================================================
// Error Display
// =============================================================================

function displayError(error: { code: string; message: string; wait_seconds?: number }): void {
  console.error(`${c.red}Error [${error.code}]:${c.reset} ${error.message}`);
  if (error.wait_seconds !== undefined) {
    console.error(`${c.yellow}Wait ${error.wait_seconds.toFixed(1)}s before retrying.${c.reset}`);
  }
  const help = ERROR_HELP[error.code];
  if (help) console.error(`\n${c.cyan}Hint:${c.reset} ${help}`);
}

// =============================================================================
// Help
// =============================================================================

function showHelp(): void {
  console.log(`
${c.bright}SpaceMolt MCP Client v${VERSION}${c.reset}
Uses Model Context Protocol (MCP) to connect to SpaceMolt.

${c.bright}Quick Start:${c.reset}
  spacemolt register myname solarian YOUR_CODE
  spacemolt get_status
  spacemolt undock
  spacemolt mine

${c.bright}Usage:${c.reset}
  spacemolt <command> [args...]

  Arguments: positional or key=value
    spacemolt travel sol_asteroid_belt
    spacemolt travel target_poi=sol_asteroid_belt

${c.bright}Common Commands:${c.reset}
  register <name> <empire> <code>  Create account
  login <name> <password>          Login
  get_status                       Your player/ship/location
  get_system                       Current system POIs
  undock / dock                    Leave/enter station
  travel <poi_id>                  Travel within system
  jump <system_id>                 Jump to connected system
  mine                             Mine resources
  sell <item_id> <qty>             Sell items
  help                             Full command list

${c.bright}Environment:${c.reset}
  SPACEMOLT_MCP_URL   MCP endpoint (default: ${MCP_URL})
  SPACEMOLT_SESSION   Session file path
  DEBUG=true          Verbose logging

${c.bright}Protocol:${c.reset} MCP 2025-03-26 (Streamable HTTP)
${c.bright}Server:${c.reset}   ${MCP_URL}
`);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`SpaceMolt MCP Client v${VERSION}`);
    console.log(`MCP Endpoint: ${MCP_URL}`);
    process.exit(0);
  }

  const { command, payload } = parseArgs(args);

  if (!command) {
    showHelp();
    process.exit(0);
  }

  try {
    const missingArg = validateRequiredArgs(command, payload);
    if (missingArg) {
      console.error(`${c.red}Error:${c.reset} Missing required argument: ${c.yellow}${missingArg}${c.reset}`);
      console.error(`Usage: spacemolt ${command} ${COMMANDS[command]?.usage || '<args...>'}`);
      process.exit(1);
    }

    // Save credentials for auto-relogin
    if (command === 'login' && payload.username && payload.password) {
      const session = await getOrCreateMcpSession();
      session.username = payload.username;
      session.password = payload.password;
      await saveSession(session);
    }
    if (command === 'register' && payload.username) {
      const session = await getOrCreateMcpSession();
      session.username = payload.username;
      await saveSession(session);
    }

    const typedPayload = Object.keys(payload).length > 0 ? convertPayloadTypes(payload) : {};
    const response = await execute(command, typedPayload);

    if (response.notifications?.length) {
      console.log(`${c.dim}--- Notifications (${response.notifications.length}) ---${c.reset}`);
      displayNotifications(response.notifications);
      console.log('');
    }

    if (response.error) {
      displayError(response.error);
      process.exit(1);
    }

    displayResult(command, response.result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${c.red}${c.bright}Connection Error:${c.reset} ${msg}`);
    if (msg.includes('fetch') || msg.includes('ECONNREFUSED') || msg.includes('network')) {
      console.error(`\n${c.yellow}Check internet connection and server status.${c.reset}`);
      console.error(`MCP endpoint: ${MCP_URL}`);
    }
    if (DEBUG) console.error(error);
    process.exit(1);
  }
}

main();

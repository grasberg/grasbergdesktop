/**
 * Connector catalog (v53): one-click templates for the apps personal agents
 * connect to (dots' plugin ecosystem, Muse's Gmail/Calendar/OpenTable/Plaid,
 * Grok Bot's Google Workspace/Slack/Notion/…). Every entry is a plain MCP
 * server config the user can still edit; nothing here is special-cased at
 * runtime. Remote entries use the vendor's official hosted endpoint
 * (Streamable HTTP, with automatic fallback to legacy SSE); 'oauth' ones sign
 * in through the browser, 'bearer'/'header' ones take an API key that is
 * stored encrypted like any MCP secret header.
 *
 * Zapier is the multiplier: one connector reaches thousands of apps.
 */

export type ConnectorCategory =
  | 'Productivity'
  | 'Communication'
  | 'Calendar & email'
  | 'Files & knowledge'
  | 'Design'
  | 'Development'
  | 'Money'
  | 'Sales & support'
  | 'Search & data'
  | 'Travel & life'
  | 'Automation'
  | 'This computer'

export interface ConnectorTemplate {
  id: string
  name: string
  category: ConnectorCategory
  description: string
  transport: 'http' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  /**
   * 'oauth' = browser sign-in; 'bearer' = API key sent as "Authorization:
   * Bearer <key>"; 'header' = API key in `secret.header`; 'env' = stdio env
   * var(s); 'none' = open.
   */
  auth: 'oauth' | 'bearer' | 'header' | 'env' | 'none'
  secret?: {
    label: string
    placeholder?: string
    /** Header name for 'header' auth. */
    header?: string
    /** Env var names for 'env' auth (one input each). */
    env?: string[]
  }
  /** Suggested access: money and write-heavy services start read-only. */
  access: 'read' | 'write'
  /** Shown under the card: what the user needs first. */
  note?: string
}

export const CONNECTOR_CATALOG: readonly ConnectorTemplate[] = [
  // -- Automation -----------------------------------------------------------
  {
    id: 'zapier',
    name: 'Zapier',
    category: 'Automation',
    description: 'Thousands of apps through one connector — Gmail, Sheets, HubSpot, Trello and more.',
    transport: 'http',
    url: 'https://mcp.zapier.com/api/mcp/mcp',
    auth: 'bearer',
    secret: { label: 'Zapier MCP API key', placeholder: 'from mcp.zapier.com' },
    access: 'write',
    note: 'Create an MCP server at mcp.zapier.com, pick the actions to expose and copy its key.',
  },
  // -- Calendar & email -----------------------------------------------------
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    category: 'Calendar & email',
    description: 'Gmail, Google Calendar, Drive, Docs and Sheets.',
    transport: 'stdio',
    command: 'uvx',
    args: ['workspace-mcp', '--tool-tier', 'core'],
    auth: 'env',
    secret: { label: 'Google OAuth client', env: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'] },
    access: 'write',
    note: 'Needs uv installed and an OAuth client (Desktop app) from Google Cloud Console.',
  },
  {
    id: 'calendly',
    name: 'Calendly',
    category: 'Calendar & email',
    description: 'Scheduling links, event types and bookings.',
    transport: 'http',
    url: 'https://mcp.calendly.com',
    auth: 'oauth',
    access: 'write',
  },
  // -- Productivity ---------------------------------------------------------
  {
    id: 'notion',
    name: 'Notion',
    category: 'Productivity',
    description: 'Search, read and update pages and databases.',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    access: 'write',
  },
  {
    id: 'todoist',
    name: 'Todoist',
    category: 'Productivity',
    description: 'Tasks, projects and due dates.',
    transport: 'http',
    url: 'https://ai.todoist.net/mcp',
    auth: 'oauth',
    access: 'write',
  },
  {
    id: 'asana',
    name: 'Asana',
    category: 'Productivity',
    description: 'Tasks, projects and teams.',
    transport: 'http',
    url: 'https://mcp.asana.com/mcp',
    auth: 'oauth',
    access: 'write',
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'Productivity',
    description: 'Issues, projects and cycles.',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    access: 'write',
  },
  {
    id: 'atlassian',
    name: 'Jira & Confluence',
    category: 'Productivity',
    description: 'Atlassian Jira issues and Confluence pages.',
    transport: 'http',
    url: 'https://mcp.atlassian.com/v1/mcp',
    auth: 'oauth',
    access: 'write',
  },
  {
    id: 'clickup',
    name: 'ClickUp',
    category: 'Productivity',
    description: 'Tasks, docs and goals.',
    transport: 'http',
    url: 'https://mcp.clickup.com/mcp',
    auth: 'oauth',
    access: 'write',
  },
  {
    id: 'monday',
    name: 'monday.com',
    category: 'Productivity',
    description: 'Boards, items and updates.',
    transport: 'http',
    url: 'https://mcp.monday.com/sse',
    auth: 'oauth',
    access: 'write',
  },
  {
    id: 'airtable',
    name: 'Airtable',
    category: 'Productivity',
    description: 'Bases, tables and records.',
    transport: 'http',
    url: 'https://mcp.airtable.com/mcp',
    auth: 'oauth',
    access: 'write',
  },
  // -- Communication --------------------------------------------------------
  {
    id: 'slack',
    name: 'Slack',
    category: 'Communication',
    description: 'Search and read channels and threads; post messages.',
    transport: 'http',
    url: 'https://mcp.slack.com/mcp',
    auth: 'oauth',
    access: 'read',
    note: 'To have a bot answer in Slack, add a Slack channel on the bot instead.',
  },
  {
    id: 'zoom',
    name: 'Zoom',
    category: 'Communication',
    description: 'Meetings, recordings and summaries.',
    transport: 'http',
    url: 'https://mcp.zoom.us/mcp/zoom/streamable',
    auth: 'oauth',
    access: 'read',
  },
  {
    id: 'granola',
    name: 'Granola',
    category: 'Communication',
    description: 'Meeting notes and transcripts.',
    transport: 'http',
    url: 'https://mcp.granola.ai/mcp',
    auth: 'oauth',
    access: 'read',
  },
  {
    id: 'fireflies',
    name: 'Fireflies.ai',
    category: 'Communication',
    description: 'Meeting transcripts and action items.',
    transport: 'http',
    url: 'https://api.fireflies.ai/mcp',
    auth: 'oauth',
    access: 'read',
  },
  // -- Files & knowledge ----------------------------------------------------
  {
    id: 'box',
    name: 'Box',
    category: 'Files & knowledge',
    description: 'Files and folders in Box.',
    transport: 'http',
    url: 'https://mcp.box.com',
    auth: 'oauth',
    access: 'read',
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    category: 'Files & knowledge',
    description: 'Ask questions about any public GitHub repository.',
    transport: 'http',
    url: 'https://mcp.deepwiki.com/sse',
    auth: 'none',
    access: 'read',
  },
  // -- Design ---------------------------------------------------------------
  {
    id: 'canva',
    name: 'Canva',
    category: 'Design',
    description: 'Create and edit designs.',
    transport: 'http',
    url: 'https://mcp.canva.com/mcp',
    auth: 'oauth',
    access: 'write',
  },
  {
    id: 'figma',
    name: 'Figma',
    category: 'Design',
    description: 'Read design files, frames and components.',
    transport: 'http',
    url: 'https://mcp.figma.com/mcp',
    auth: 'oauth',
    access: 'read',
  },
  {
    id: 'miro',
    name: 'Miro',
    category: 'Design',
    description: 'Boards, sticky notes and diagrams.',
    transport: 'http',
    url: 'https://mcp.miro.com/',
    auth: 'oauth',
    access: 'write',
  },
  // -- Development ----------------------------------------------------------
  {
    id: 'github',
    name: 'GitHub',
    category: 'Development',
    description: 'Repositories, issues, pull requests and Actions.',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp',
    auth: 'oauth',
    access: 'write',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'Development',
    description: 'Errors, issues and releases.',
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
    access: 'read',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    category: 'Development',
    description: 'Projects, deployments and logs.',
    transport: 'http',
    url: 'https://mcp.vercel.com/',
    auth: 'oauth',
    access: 'read',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'Development',
    description: 'Databases, auth and storage.',
    transport: 'http',
    url: 'https://mcp.supabase.com/mcp',
    auth: 'oauth',
    access: 'read',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    category: 'Development',
    description: 'Models, datasets, Spaces and papers.',
    transport: 'http',
    url: 'https://hf.co/mcp',
    auth: 'none',
    access: 'read',
  },
  // -- Money ----------------------------------------------------------------
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Money',
    description: 'Customers, payments, invoices and subscriptions.',
    transport: 'http',
    url: 'https://mcp.stripe.com/',
    auth: 'oauth',
    access: 'read',
    note: 'Starts read-only: moving money stays a step you approve.',
  },
  {
    id: 'paypal',
    name: 'PayPal',
    category: 'Money',
    description: 'Invoices, orders and transactions.',
    transport: 'http',
    url: 'https://mcp.paypal.com/sse',
    auth: 'oauth',
    access: 'read',
  },
  {
    id: 'square',
    name: 'Square',
    category: 'Money',
    description: 'Payments, orders and catalog.',
    transport: 'http',
    url: 'https://mcp.squareup.com/sse',
    auth: 'oauth',
    access: 'read',
  },
  {
    id: 'plaid',
    name: 'Plaid',
    category: 'Money',
    description: 'Bank connections and transactions (developer dashboard).',
    transport: 'http',
    url: 'https://api.dashboard.plaid.com/mcp/sse',
    auth: 'oauth',
    access: 'read',
  },
  {
    id: 'ramp',
    name: 'Ramp',
    category: 'Money',
    description: 'Corporate cards, spend and bills.',
    transport: 'http',
    url: 'https://ramp-mcp-remote.ramp.com/mcp',
    auth: 'oauth',
    access: 'read',
  },
  // -- Sales & support ------------------------------------------------------
  {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'Sales & support',
    description: 'Contacts, companies, deals and tickets.',
    transport: 'http',
    url: 'https://app.hubspot.com/mcp/v1/http',
    auth: 'bearer',
    secret: { label: 'HubSpot private app token', placeholder: 'pat-…' },
    access: 'read',
  },
  {
    id: 'intercom',
    name: 'Intercom',
    category: 'Sales & support',
    description: 'Conversations, contacts and help articles.',
    transport: 'http',
    url: 'https://mcp.intercom.com/sse',
    auth: 'oauth',
    access: 'read',
  },
  {
    id: 'attio',
    name: 'Attio',
    category: 'Sales & support',
    description: 'CRM records, lists and notes.',
    transport: 'http',
    url: 'https://mcp.attio.com/mcp',
    auth: 'oauth',
    access: 'write',
  },
  // -- Search & data --------------------------------------------------------
  {
    id: 'exa',
    name: 'Exa Search',
    category: 'Search & data',
    description: 'Neural web search with full-page content.',
    transport: 'http',
    url: 'https://mcp.exa.ai/mcp',
    auth: 'none',
    access: 'read',
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    category: 'Search & data',
    description: 'Places, routes and directions.',
    transport: 'http',
    url: 'https://mapstools.googleapis.com/mcp',
    auth: 'header',
    secret: { label: 'Google Maps API key', header: 'X-Goog-Api-Key' },
    access: 'read',
  },
  {
    id: 'wolfram',
    name: 'Wolfram',
    category: 'Search & data',
    description: 'Computation, math, units and facts.',
    transport: 'http',
    url: 'https://agenttools.wolfram.com/mcp',
    auth: 'none',
    access: 'read',
  },
  // -- Travel & life --------------------------------------------------------
  {
    id: 'turkish-airlines',
    name: 'Turkish Airlines',
    category: 'Travel & life',
    description: 'Flight search, bookings and status.',
    transport: 'http',
    url: 'https://mcp.turkishtechlab.com/mcp',
    auth: 'oauth',
    access: 'read',
  },
  {
    id: 'ferryhopper',
    name: 'Ferryhopper',
    category: 'Travel & life',
    description: 'Ferry routes, timetables and prices.',
    transport: 'http',
    url: 'https://mcp.ferryhopper.com/mcp',
    auth: 'none',
    access: 'read',
  },
  {
    id: 'peek',
    name: 'Peek',
    category: 'Travel & life',
    description: 'Tours, activities and experiences.',
    transport: 'http',
    url: 'https://mcp.peek.com',
    auth: 'none',
    access: 'read',
  },
  // -- This computer --------------------------------------------------------
  {
    id: 'filesystem',
    name: 'Folder access',
    category: 'This computer',
    description: 'Read and write files in one folder on this computer.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '<folder path>'],
    auth: 'none',
    access: 'read',
    note: 'Replace <folder path> with the folder the agent may use. Needs Node.js.',
  },
  {
    id: 'playwright',
    name: 'Playwright browser',
    category: 'This computer',
    description: 'A full Chromium the agent drives (alternative to the built-in browser).',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    auth: 'none',
    access: 'write',
    note: 'Needs Node.js.',
  },
]

export const CONNECTOR_CATEGORIES: readonly ConnectorCategory[] = [
  'Automation',
  'Calendar & email',
  'Productivity',
  'Communication',
  'Files & knowledge',
  'Design',
  'Development',
  'Money',
  'Sales & support',
  'Search & data',
  'Travel & life',
  'This computer',
]

/**
 * The McpServerInput a template becomes, given the user's secret values
 * (one per env var for 'env', a single key otherwise).
 */
export function connectorToServerInput(
  template: ConnectorTemplate,
  secretValues: string[] = []
): {
  name: string
  transport: 'http' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  setSecrets?: Record<string, string>
  access: 'read' | 'write'
} {
  const setSecrets: Record<string, string> = {}
  const first = (secretValues[0] ?? '').trim()
  if (template.auth === 'bearer' && first) setSecrets.Authorization = `Bearer ${first}`
  if (template.auth === 'header' && first && template.secret?.header) setSecrets[template.secret.header] = first
  if (template.auth === 'env') {
    template.secret?.env?.forEach((name, index) => {
      const value = (secretValues[index] ?? '').trim()
      if (value) setSecrets[name] = value
    })
  }
  return {
    name: template.name,
    transport: template.transport,
    ...(template.url ? { url: template.url } : {}),
    ...(template.command ? { command: template.command } : {}),
    ...(template.args ? { args: [...template.args] } : {}),
    ...(Object.keys(setSecrets).length > 0 ? { setSecrets } : {}),
    access: template.access,
  }
}

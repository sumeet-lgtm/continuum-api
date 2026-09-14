/**
 * Thin Salesforce REST API client. Every call targets the connection's own
 * instanceUrl (never a fixed host — Salesforce is multi-tenant at the DNS
 * level) with a fresh access token from lib/oauth/salesforce.ts.
 */
import { logger } from './logger.js';

const API_VERSION = 'v60.0';

export class SalesforceApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'SalesforceApiError';
  }
}

async function sfRequest<T>(
  instanceUrl: string,
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${instanceUrl}/services/data/${API_VERSION}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    // Salesforce error bodies are an array of {message, errorCode}, not a
    // single object — surface the first one, it's almost always the only
    // one that matters (duplicate rule, validation rule, field-level
    // security on a field this connection's user profile can't write to).
    const message = Array.isArray(data) ? data[0]?.message ?? res.statusText : res.statusText;
    throw new SalesforceApiError(message, res.status);
  }

  return data as T;
}

interface SfLeadQueryResult {
  totalSize: number;
  records: Array<{ Id: string; Status: string | null; LastModifiedDate: string; IsConverted?: boolean; ConvertedContactId?: string | null }>;
}

/** Finds an existing Lead by email — Salesforce has no native upsert-by-email for standard Leads. */
export async function findLeadByEmail(instanceUrl: string, accessToken: string, email: string): Promise<{ id: string; status: string | null; lastModified: string; converted: boolean; convertedContactId: string | null } | null> {
  const soql = `SELECT Id, Status, LastModifiedDate, IsConverted, ConvertedContactId FROM Lead WHERE Email = '${email.replace(/'/g, "\\'")}' LIMIT 1`;
  const result = await sfRequest<SfLeadQueryResult>(instanceUrl, accessToken, `/query?q=${encodeURIComponent(soql)}`);
  const record = result.records[0];
  if (!record) return null;
  return {
    id: record.Id,
    status: record.Status,
    lastModified: record.LastModifiedDate,
    converted: record.IsConverted ?? false,
    convertedContactId: record.ConvertedContactId ?? null,
  };
}

export interface SfLeadFields {
  Email: string;
  FirstName?: string | undefined;
  LastName: string; // required by Salesforce on Lead — falls back to "(Unknown)" if we have nothing
  Company: string;   // also required — falls back to the email's domain
  Title?: string | undefined;
  LeadSource?: string | undefined;
  Description?: string | undefined;
  // Per-connection custom field mappings (SalesforceConnection.fieldMappings)
  // can target any other field on the org's Lead layout — most commonly a
  // custom field, which Salesforce always suffixes with "__c" by convention.
  [customField: string]: string | undefined;
}

export interface SalesforceFieldMapping {
  /** One of our own field names, or "customVars.<key>" for a value stored in Lead.customVars. */
  source: "firstName" | "lastName" | "company" | "title" | "tags" | `customVars.${string}`;
  /** The literal Salesforce field API name to push it into — almost always a custom field, which Salesforce always suffixes "__c". */
  target: string;
}

// Which standard field a built-in source writes to by default, so a mapping
// can be recognized as "override the default target" vs. "an additional
// custom field to also populate".
const DEFAULT_TARGET: Partial<Record<SalesforceFieldMapping["source"], keyof SfLeadFields>> = {
  firstName: "FirstName",
  lastName: "LastName",
  company: "Company",
  title: "Title",
};

// LastName and Company are mandatory on a Salesforce Lead regardless of any
// mapping (Salesforce itself rejects a create/update without them), so a
// mapping for those two always adds the custom field alongside the standard
// one rather than replacing it. FirstName/Title/tags/customVars are
// optional, so mapping those fully redirects to the custom target instead.
const ALWAYS_KEEP_DEFAULT = new Set<SalesforceFieldMapping["source"]>(["lastName", "company"]);

/**
 * Applies a connection's custom field mappings on top of the standard
 * fields already built from a lead. Called right before create/updateLead.
 * No mappings configured -> baseFields comes back unchanged (the old,
 * hardcoded-fields behavior).
 */
export function applyFieldMappings(
  baseFields: SfLeadFields,
  lead: { firstName?: string | null; lastName?: string | null; company?: string | null; title?: string | null; tags?: string[] | null; customVars?: Record<string, unknown> | null },
  mappings: SalesforceFieldMapping[] | null | undefined,
): SfLeadFields {
  if (!mappings?.length) return baseFields;
  const fields: SfLeadFields = { ...baseFields };

  for (const { source, target } of mappings) {
    if (!source || !target) continue;

    let value: string | undefined;
    if (source === "tags") {
      value = lead.tags?.length ? lead.tags.join(";") : undefined;
    } else if (source.startsWith("customVars.")) {
      const key = source.slice("customVars.".length);
      const raw = lead.customVars?.[key];
      value = raw === undefined || raw === null ? undefined : String(raw);
    } else if (source === "firstName") {
      value = lead.firstName ?? undefined;
    } else if (source === "lastName") {
      value = lead.lastName ?? undefined;
    } else if (source === "company") {
      value = lead.company ?? undefined;
    } else {
      value = lead.title ?? undefined;
    }
    if (value === undefined) continue;

    const defaultTarget = DEFAULT_TARGET[source];
    if (defaultTarget && defaultTarget !== target && !ALWAYS_KEEP_DEFAULT.has(source)) {
      delete fields[defaultTarget];
    }
    fields[target] = value;
  }

  return fields;
}

export async function createLead(instanceUrl: string, accessToken: string, fields: SfLeadFields): Promise<string> {
  const result = await sfRequest<{ id: string }>(instanceUrl, accessToken, '/sobjects/Lead', {
    method: 'POST',
    body: JSON.stringify(fields),
  });
  return result.id;
}

export async function updateLead(instanceUrl: string, accessToken: string, id: string, fields: Partial<SfLeadFields>): Promise<void> {
  await sfRequest<void>(instanceUrl, accessToken, `/sobjects/Lead/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

/**
 * Logs a reply as a completed Task on the Lead (or Contact, if the lead has
 * since converted) record — what a Salesforce user actually sees as
 * activity history, same as any other logged call/email.
 */
export async function logActivity(instanceUrl: string, accessToken: string, whoId: string, subject: string, description: string): Promise<void> {
  await sfRequest<{ id: string }>(instanceUrl, accessToken, '/sobjects/Task', {
    method: 'POST',
    body: JSON.stringify({
      WhoId: whoId,
      Subject: subject,
      Description: description,
      Status: 'Completed',
      ActivityDate: new Date().toISOString().slice(0, 10),
    }),
  });
}

/** Batched re-check for the pull direction — one query instead of one per synced lead. */
export async function queryLeadsById(instanceUrl: string, accessToken: string, ids: string[]): Promise<SfLeadQueryResult['records']> {
  if (ids.length === 0) return [];
  const idList = ids.map((id) => `'${id}'`).join(',');
  const soql = `SELECT Id, Status, LastModifiedDate, IsConverted, ConvertedContactId FROM Lead WHERE Id IN (${idList})`;
  const result = await sfRequest<SfLeadQueryResult>(instanceUrl, accessToken, `/query?q=${encodeURIComponent(soql)}`);
  return result.records;
}

export async function testConnection(instanceUrl: string, accessToken: string): Promise<boolean> {
  try {
    await sfRequest(instanceUrl, accessToken, '/limits');
    return true;
  } catch (err) {
    logger.warn({ err, instanceUrl }, 'Salesforce connection test failed');
    return false;
  }
}

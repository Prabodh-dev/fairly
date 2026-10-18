import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { parse } from 'yaml';

export interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, OperationObject>>;
  components: Record<string, Record<string, unknown>>;
}

interface OperationObject {
  responses: Record<string, ResponseObject>;
  requestBody?: { content: Record<string, { schema: unknown; examples?: Record<string, { value: unknown }> }> };
}

interface ResponseObject {
  $ref?: string;
  headers?: Record<string, { $ref?: string; schema?: unknown }>;
  content?: Record<string, unknown>;
}

export const SPEC_URL = new URL('../openapi.yaml', import.meta.url);

export function loadSpec(): OpenApiDocument {
  return parse(readFileSync(SPEC_URL, 'utf8')) as OpenApiDocument;
}

function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function lookup(spec: OpenApiDocument, pointer: string): unknown {
  let node: unknown = spec;
  for (const segment of pointer.replace(/^#?\//, '').split('/')) {
    node = (node as Record<string, unknown>)[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return node;
}

const RATE_LIMIT_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after', 'x-fairly-degraded'];

export class SpecConformance {
  private readonly ajv = new Ajv({ strict: false, allErrors: true });

  constructor(private readonly spec: OpenApiDocument) {
    this.ajv.addFormat('int64', true);
    this.ajv.addSchema(spec, 'spec');
  }

  responseConforms(
    method: string,
    path: string,
    status: number,
    body: unknown,
    headers: Headers,
    required: string[] = [],
  ): void {
    const operation = this.spec.paths[path]?.[method];
    if (operation === undefined) throw new Error(`${method} ${path} is not documented`);
    let pointer = `/paths/${escapePointer(path)}/${method}/responses/${status}`;
    let response = operation.responses[String(status)];
    if (response === undefined) throw new Error(`${method} ${path} does not document status ${status}`);
    if (response.$ref !== undefined) {
      pointer = response.$ref.slice(1);
      response = lookup(this.spec, pointer) as ResponseObject;
    }

    const mime = headers.get('content-type')?.split(';')[0] ?? '';
    if (response.content !== undefined && body !== undefined) {
      if (!(mime in response.content)) throw new Error(`${method} ${path} ${status} returned undocumented content type ${mime}`);
      if (mime === 'application/json') {
        const validate = this.ajv.compile({ $ref: `spec#${pointer}/content/${escapePointer(mime)}/schema` });
        if (!validate(body)) {
          throw new Error(`${method} ${path} ${status} body does not match the spec: ${this.ajv.errorsText(validate.errors)}`);
        }
      }
    }

    const declared = response.headers ?? {};
    for (const name of RATE_LIMIT_HEADERS) {
      const value = headers.get(name);
      const key = Object.keys(declared).find((candidate) => candidate.toLowerCase() === name);
      if (value !== null && key === undefined) {
        throw new Error(`${method} ${path} ${status} sent header ${name} that the spec does not declare`);
      }
      if (value !== null && key !== undefined) {
        const declaration = declared[key];
        const header = (declaration?.$ref === undefined ? declaration : lookup(this.spec, declaration.$ref)) as { schema: unknown };
        const validate = this.ajv.compile(header.schema as object);
        const typed = (header.schema as { type: string }).type === 'integer' ? Number(value) : value;
        if (!validate(typed)) {
          throw new Error(`${method} ${path} ${status} header ${name}=${value} does not match the spec: ${this.ajv.errorsText(validate.errors)}`);
        }
      }
    }
    for (const name of required) {
      if (headers.get(name) === null) throw new Error(`${method} ${path} ${status} is missing required header ${name}`);
    }
  }
}

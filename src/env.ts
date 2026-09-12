import type { WegmansAuth } from "./tokens.js"

export interface Env {
  WEGMANS_EMAIL: string
  WEGMANS_PASSWORD: string
  WEGMANS_CUSTOMER_ID: string
  MCP_BEARER: string
  WEGMANS_STORE: string
  DATA: KVNamespace
  WEGMANS_AUTH: DurableObjectNamespace<WegmansAuth>
}

let current: Env
export const setEnv = (value: Env) => { current = value }
export const env = () => current

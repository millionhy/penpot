// Minimal RPC typings for the scaffold, covering the P0 vertical slice.
//
// The authoritative, generated types come from packages/api-types (produced from
// the backend RPC inventory / OpenAPI), tracked as a Phase-F task. Until then,
// commands default to unknown params/results so the transport boundary stays
// type-safe without hand-porting 400+ command schemas.

export interface Profile {
  id: string;
  email: string;
  fullname: string;
  default_team_id?: string;
  default_project_id?: string;
  is_active?: boolean;
  [key: string]: unknown;
}

export interface LoginWithPasswordParams {
  email: string;
  password: string;
}

export interface Team {
  id: string;
  name: string;
  [key: string]: unknown;
}
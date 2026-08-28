/**
 * Row shapes for the tables the app reads. Hand-written rather than
 * generated so the repo does not depend on the Supabase CLI having
 * project access; keep these in step with supabase/migrations.
 */

export interface Profile {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  is_site_admin: boolean;
}

export type LeagueStatus =
  | "setup"
  | "drafting"
  | "in_season"
  | "playoffs"
  | "complete";

export interface League {
  id: string;
  name: string;
  season: number;
  commissioner_id: string;
  join_code: string;
  status: LeagueStatus;
  current_week: number;
  regular_season_weeks: number;
  playoff_start_week: number;
  playoff_teams: number;
  draft_type: "snake" | "auction";
  waiver_type: "faab" | "priority";
  faab_budget: number;
  min_bid: number;
  waiver_process_dow: number;
  waiver_process_time: string;
  waiver_period_hours: number;
  faab_tie_breaker: "waiver_priority" | "earliest_bid" | "random";
  lineup_lock_mode: "per_player" | "weekly_kickoff";
  timezone: string;
}

export interface LeagueMember {
  id: string;
  league_id: string;
  user_id: string;
  role: "commissioner" | "member";
}

export interface Team {
  id: string;
  league_id: string;
  owner_id: string | null;
  name: string;
  abbreviation: string;
  logo_url: string | null;
  faab_remaining: number;
  waiver_priority: number;
}

export interface RosterSlot {
  id: string;
  league_id: string;
  slot_key: string;
  label: string;
  eligible_positions: string[];
  count: number;
  is_starter: boolean;
  order_index: number;
}

export interface NflPlayer {
  id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  team_abbr: string | null;
  jersey_number: number | null;
  status: string | null;
  headshot_url: string | null;
}

export interface NflGame {
  id: string;
  season: number;
  week: number;
  season_type: string;
  home_team: string | null;
  away_team: string | null;
  kickoff_at: string | null;
  home_score: number | null;
  away_score: number | null;
  status: "scheduled" | "in_progress" | "final" | "postponed";
}

export interface RosterPlayer {
  id: string;
  league_id: string;
  team_id: string;
  player_id: string;
  acquired_via: "draft" | "free_agent" | "waiver" | "trade" | "commissioner";
  acquired_at: string;
  dropped_at: string | null;
}

export interface LineupEntry {
  id: string;
  league_id: string;
  team_id: string;
  season: number;
  week: number;
  player_id: string;
  slot_key: string;
  locked_at: string | null;
}

export interface Matchup {
  id: string;
  league_id: string;
  season: number;
  week: number;
  home_team_id: string;
  away_team_id: string | null;
  home_score: number;
  away_score: number;
  is_playoff: boolean;
  playoff_round: string | null;
  status: "scheduled" | "in_progress" | "final";
}

export interface StandingsRow {
  league_id: string;
  team_id: string;
  team_name: string;
  owner_id: string | null;
  games_played: number;
  wins: number;
  losses: number;
  ties: number;
  points_for: number;
  points_against: number;
  win_pct: number;
}

export interface Transaction {
  id: string;
  league_id: string;
  team_id: string | null;
  related_team_id: string | null;
  type:
    | "add"
    | "drop"
    | "waiver_add"
    | "waiver_failed"
    | "trade"
    | "draft"
    | "commissioner";
  player_id: string | null;
  bid_amount: number | null;
  season: number;
  week: number;
  note: string;
  created_by: string | null;
  created_at: string;
}

export interface WaiverClaim {
  id: string;
  league_id: string;
  team_id: string;
  add_player_id: string;
  drop_player_id: string | null;
  bid_amount: number;
  claim_priority: number;
  status: "pending" | "won" | "lost" | "invalid" | "cancelled";
  result_note: string;
  season: number;
  week: number;
  created_at: string;
  processed_at: string | null;
}

export interface StatDefinition {
  key: string;
  label: string;
  category: string;
  description: string;
  applies_to: "player" | "team_defense";
  value_type: "count" | "flag" | "rate";
  default_points: number;
  scorable: boolean;
  /** Which ingestion job populates this stat. */
  source: string;
  /** False while nothing populates it yet. */
  tracked: boolean;
  sort_order: number;
}

export interface ScoringRule {
  id: string;
  league_id: string;
  stat_key: string;
  points: number;
  positions: string[];
}

/** One stat's contribution to a fantasy score. */
export interface ScoreBreakdownEntry {
  value: number;
  points: number;
}

export interface PlayerWeekScore {
  id: number;
  league_id: string;
  player_id: string;
  season: number;
  week: number;
  points: number;
  breakdown: Record<string, ScoreBreakdownEntry>;
  is_final: boolean;
}

export interface Draft {
  id: string;
  league_id: string;
  type: "snake" | "auction";
  status: "scheduled" | "live" | "paused" | "complete";
  rounds: number;
  seconds_per_pick: number;
  auction_budget: number;
  scheduled_at: string | null;
  current_pick_number: number;
  pick_deadline: string | null;
  autopick_enabled: boolean;
}

export interface DraftPick {
  id: string;
  draft_id: string;
  league_id: string;
  pick_number: number;
  round: number;
  round_pick: number;
  team_id: string;
  player_id: string | null;
  is_autopick: boolean;
  picked_at: string | null;
}

export interface Trade {
  id: string;
  league_id: string;
  proposing_team_id: string;
  receiving_team_id: string;
  status:
    | "pending"
    | "accepted"
    | "rejected"
    | "cancelled"
    | "vetoed"
    | "completed";
  note: string;
  season: number;
  week: number;
  created_at: string;
  expires_at: string;
}

export interface TradeItem {
  id: string;
  trade_id: string;
  from_team_id: string;
  player_id: string | null;
  faab_amount: number | null;
}

export interface LeagueMessage {
  id: string;
  league_id: string;
  user_id: string;
  body: string;
  is_system: boolean;
  created_at: string;
}

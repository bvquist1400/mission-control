export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      briefing_review_snapshots: {
        Row: {
          anchor_date: string
          created_at: string
          id: string
          payload: Json
          period_end: string
          period_start: string
          review_type: string
          source: string
          summary: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          anchor_date: string
          created_at?: string
          id?: string
          payload?: Json
          period_end: string
          period_start: string
          review_type: string
          source?: string
          summary?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          anchor_date?: string
          created_at?: string
          id?: string
          payload?: Json
          period_end?: string
          period_start?: string
          review_type?: string
          source?: string
          summary?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      calendar_event_context: {
        Row: {
          created_at: string
          external_event_id: string
          id: string
          meeting_context: string
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          external_event_id: string
          id?: string
          meeting_context: string
          source: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          external_event_id?: string
          id?: string
          meeting_context?: string
          source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      calendar_events: {
        Row: {
          body_scrubbed: string | null
          body_scrubbed_preview: string | null
          content_hash: string
          created_at: string
          end_at: string
          external_event_id: string
          id: string
          ingested_at: string
          is_all_day: boolean
          organizer_display: string | null
          source: string
          start_at: string
          title: string
          updated_at: string
          user_id: string
          with_display: Json
        }
        Insert: {
          body_scrubbed?: string | null
          body_scrubbed_preview?: string | null
          content_hash: string
          created_at?: string
          end_at: string
          external_event_id: string
          id?: string
          ingested_at?: string
          is_all_day?: boolean
          organizer_display?: string | null
          source: string
          start_at: string
          title: string
          updated_at?: string
          user_id: string
          with_display?: Json
        }
        Update: {
          body_scrubbed?: string | null
          body_scrubbed_preview?: string | null
          content_hash?: string
          created_at?: string
          end_at?: string
          external_event_id?: string
          id?: string
          ingested_at?: string
          is_all_day?: boolean
          organizer_display?: string | null
          source?: string
          start_at?: string
          title?: string
          updated_at?: string
          user_id?: string
          with_display?: Json
        }
        Relationships: []
      }
      calendar_snapshots: {
        Row: {
          captured_at: string
          id: string
          payload_min: Json
          range_end: string
          range_start: string
          user_id: string
        }
        Insert: {
          captured_at?: string
          id?: string
          payload_min?: Json
          range_end: string
          range_start: string
          user_id: string
        }
        Update: {
          captured_at?: string
          id?: string
          payload_min?: Json
          range_end?: string
          range_start?: string
          user_id?: string
        }
        Relationships: []
      }
      commitments: {
        Row: {
          created_at: string
          direction: Database["public"]["Enums"]["commitment_direction"]
          done_at: string | null
          due_at: string | null
          id: string
          notes: string | null
          stakeholder_id: string
          status: Database["public"]["Enums"]["commitment_status"]
          task_id: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          direction?: Database["public"]["Enums"]["commitment_direction"]
          done_at?: string | null
          due_at?: string | null
          id?: string
          notes?: string | null
          stakeholder_id: string
          status?: Database["public"]["Enums"]["commitment_status"]
          task_id?: string | null
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          direction?: Database["public"]["Enums"]["commitment_direction"]
          done_at?: string | null
          due_at?: string | null
          id?: string
          notes?: string | null
          stakeholder_id?: string
          status?: Database["public"]["Enums"]["commitment_status"]
          task_id?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "commitments_stakeholder_id_fkey"
            columns: ["stakeholder_id"]
            isOneToOne: false
            referencedRelation: "stakeholders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commitments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      focus_directives: {
        Row: {
          created_at: string
          created_by: string
          ends_at: string | null
          id: string
          is_active: boolean
          reason: string | null
          scope_id: string | null
          scope_type: string
          scope_value: string | null
          starts_at: string | null
          strength: string
          text: string
        }
        Insert: {
          created_at?: string
          created_by: string
          ends_at?: string | null
          id?: string
          is_active?: boolean
          reason?: string | null
          scope_id?: string | null
          scope_type: string
          scope_value?: string | null
          starts_at?: string | null
          strength?: string
          text: string
        }
        Update: {
          created_at?: string
          created_by?: string
          ends_at?: string | null
          id?: string
          is_active?: boolean
          reason?: string | null
          scope_id?: string | null
          scope_type?: string
          scope_value?: string | null
          starts_at?: string | null
          strength?: string
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "focus_directives_scope_id_fkey"
            columns: ["scope_id"]
            isOneToOne: false
            referencedRelation: "implementations"
            referencedColumns: ["id"]
          },
        ]
      }
      implementations: {
        Row: {
          created_at: string
          health_snapshot: Json | null
          id: string
          keywords: string[]
          name: string
          next_milestone: string
          next_milestone_date: string | null
          phase: Database["public"]["Enums"]["impl_phase"]
          portfolio_rank: number
          priority_note: string | null
          priority_weight: number
          rag: Database["public"]["Enums"]["rag_status"]
          stakeholders: string[]
          status_summary: string
          target_date: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          health_snapshot?: Json | null
          id?: string
          keywords?: string[]
          name: string
          next_milestone?: string
          next_milestone_date?: string | null
          phase?: Database["public"]["Enums"]["impl_phase"]
          portfolio_rank?: number
          priority_note?: string | null
          priority_weight?: number
          rag?: Database["public"]["Enums"]["rag_status"]
          stakeholders?: string[]
          status_summary?: string
          target_date?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          health_snapshot?: Json | null
          id?: string
          keywords?: string[]
          name?: string
          next_milestone?: string
          next_milestone_date?: string | null
          phase?: Database["public"]["Enums"]["impl_phase"]
          portfolio_rank?: number
          priority_note?: string | null
          priority_weight?: number
          rag?: Database["public"]["Enums"]["rag_status"]
          stakeholders?: string[]
          status_summary?: string
          target_date?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      inbox_items: {
        Row: {
          created_at: string
          dedupe_key: string | null
          extraction_confidence: number | null
          extraction_model: string | null
          extraction_version: number
          from_email: string | null
          from_name: string | null
          id: string
          llm_extraction_json: Json | null
          processing_error: string | null
          received_at: string
          source: string
          source_message_id: string | null
          source_url: string | null
          subject: string
          triage_state: string
          user_id: string
        }
        Insert: {
          created_at?: string
          dedupe_key?: string | null
          extraction_confidence?: number | null
          extraction_model?: string | null
          extraction_version?: number
          from_email?: string | null
          from_name?: string | null
          id?: string
          llm_extraction_json?: Json | null
          processing_error?: string | null
          received_at: string
          source: string
          source_message_id?: string | null
          source_url?: string | null
          subject: string
          triage_state?: string
          user_id: string
        }
        Update: {
          created_at?: string
          dedupe_key?: string | null
          extraction_confidence?: number | null
          extraction_model?: string | null
          extraction_version?: number
          from_email?: string | null
          from_name?: string | null
          id?: string
          llm_extraction_json?: Json | null
          processing_error?: string | null
          received_at?: string
          source?: string
          source_message_id?: string | null
          source_url?: string | null
          subject?: string
          triage_state?: string
          user_id?: string
        }
        Relationships: []
      }
      ingestion_events: {
        Row: {
          created_at: string
          detail: string | null
          id: string
          inbox_item_id: string | null
          ok: boolean
          stage: string
          user_id: string
        }
        Insert: {
          created_at?: string
          detail?: string | null
          id?: string
          inbox_item_id?: string | null
          ok?: boolean
          stage: string
          user_id: string
        }
        Update: {
          created_at?: string
          detail?: string | null
          id?: string
          inbox_item_id?: string | null
          ok?: boolean
          stage?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ingestion_events_inbox_item_id_fkey"
            columns: ["inbox_item_id"]
            isOneToOne: false
            referencedRelation: "inbox_items"
            referencedColumns: ["id"]
          },
        ]
      }
      intelligence_artifact_contract_links: {
        Row: {
          artifact_id: string
          contract_snapshot_id: string
          contract_type: string
          created_at: string
          id: string
          link_role: string
          promotion_family_key: string
          user_id: string
        }
        Insert: {
          artifact_id: string
          contract_snapshot_id: string
          contract_type: string
          created_at?: string
          id?: string
          link_role: string
          promotion_family_key: string
          user_id: string
        }
        Update: {
          artifact_id?: string
          contract_snapshot_id?: string
          contract_type?: string
          created_at?: string
          id?: string
          link_role?: string
          promotion_family_key?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intelligence_artifact_contract_links_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "intelligence_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intelligence_artifact_contract_links_contract_snapshot_id_fkey"
            columns: ["contract_snapshot_id"]
            isOneToOne: false
            referencedRelation: "intelligence_contract_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      intelligence_artifact_family_coverage: {
        Row: {
          artifact_id: string
          canonical_subject_key: string
          contract_type: string
          created_at: string
          id: string
          is_primary: boolean
          promotion_family_key: string
          subject_key: string
          user_id: string
        }
        Insert: {
          artifact_id: string
          canonical_subject_key: string
          contract_type: string
          created_at?: string
          id?: string
          is_primary?: boolean
          promotion_family_key: string
          subject_key: string
          user_id: string
        }
        Update: {
          artifact_id?: string
          canonical_subject_key?: string
          contract_type?: string
          created_at?: string
          id?: string
          is_primary?: boolean
          promotion_family_key?: string
          subject_key?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intelligence_artifact_family_coverage_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "intelligence_artifacts"
            referencedColumns: ["id"]
          },
        ]
      }
      intelligence_artifact_reminder_executions: {
        Row: {
          artifact_id: string
          completed_at: string | null
          created_at: string
          execution_kind: string
          id: string
          payload: Json
          started_at: string
          status: string
          task_comment_id: string | null
          task_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          artifact_id: string
          completed_at?: string | null
          created_at?: string
          execution_kind: string
          id?: string
          payload?: Json
          started_at: string
          status: string
          task_comment_id?: string | null
          task_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          artifact_id?: string
          completed_at?: string | null
          created_at?: string
          execution_kind?: string
          id?: string
          payload?: Json
          started_at?: string
          status?: string
          task_comment_id?: string | null
          task_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intelligence_artifact_reminder_executions_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "intelligence_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intelligence_artifact_reminder_executions_task_comment_id_fkey"
            columns: ["task_comment_id"]
            isOneToOne: false
            referencedRelation: "task_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intelligence_artifact_reminder_executions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      intelligence_artifact_status_transitions: {
        Row: {
          artifact_id: string
          created_at: string
          from_status: string | null
          id: string
          note: string | null
          payload: Json
          to_status: string
          triggered_by: string
          user_id: string
        }
        Insert: {
          artifact_id: string
          created_at?: string
          from_status?: string | null
          id?: string
          note?: string | null
          payload?: Json
          to_status: string
          triggered_by?: string
          user_id: string
        }
        Update: {
          artifact_id?: string
          created_at?: string
          from_status?: string | null
          id?: string
          note?: string | null
          payload?: Json
          to_status?: string
          triggered_by?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intelligence_artifact_status_transitions_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "intelligence_artifacts"
            referencedColumns: ["id"]
          },
        ]
      }
      intelligence_artifacts: {
        Row: {
          artifact_evidence: Json
          artifact_kind: string
          available_actions: Json
          confidence: string
          content_hash: string
          created_at: string
          grouping_key: string | null
          id: string
          last_evaluated_at: string
          primary_contract_type: string
          reason: string
          review_payload: Json
          severity: string
          status: string
          subject_key: string
          summary: string
          updated_at: string
          user_id: string
        }
        Insert: {
          artifact_evidence?: Json
          artifact_kind: string
          available_actions?: Json
          confidence: string
          content_hash: string
          created_at?: string
          grouping_key?: string | null
          id?: string
          last_evaluated_at: string
          primary_contract_type: string
          reason: string
          review_payload?: Json
          severity: string
          status: string
          subject_key: string
          summary: string
          updated_at?: string
          user_id: string
        }
        Update: {
          artifact_evidence?: Json
          artifact_kind?: string
          available_actions?: Json
          confidence?: string
          content_hash?: string
          created_at?: string
          grouping_key?: string | null
          id?: string
          last_evaluated_at?: string
          primary_contract_type?: string
          reason?: string
          review_payload?: Json
          severity?: string
          status?: string
          subject_key?: string
          summary?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      intelligence_contract_snapshots: {
        Row: {
          canonical_subject_key: string
          confidence: string
          content_hash: string
          contract_type: string
          created_at: string
          detected_at: string
          evidence_payload: Json
          id: string
          metrics_payload: Json
          promotion_family_key: string
          provenance_payload: Json
          reason: string
          severity: string
          subject_payload: Json
          summary: string
          user_id: string
        }
        Insert: {
          canonical_subject_key: string
          confidence: string
          content_hash: string
          contract_type: string
          created_at?: string
          detected_at: string
          evidence_payload?: Json
          id?: string
          metrics_payload?: Json
          promotion_family_key: string
          provenance_payload?: Json
          reason: string
          severity: string
          subject_payload?: Json
          summary: string
          user_id: string
        }
        Update: {
          canonical_subject_key?: string
          confidence?: string
          content_hash?: string
          contract_type?: string
          created_at?: string
          detected_at?: string
          evidence_payload?: Json
          id?: string
          metrics_payload?: Json
          promotion_family_key?: string
          provenance_payload?: Json
          reason?: string
          severity?: string
          subject_payload?: Json
          summary?: string
          user_id?: string
        }
        Relationships: []
      }
      intelligence_promotion_events: {
        Row: {
          artifact_id: string | null
          contract_snapshot_id: string | null
          created_at: string
          details: Json
          event_type: string
          id: string
          promotion_family_key: string
          suppression_reason: string | null
          user_id: string
        }
        Insert: {
          artifact_id?: string | null
          contract_snapshot_id?: string | null
          created_at?: string
          details?: Json
          event_type: string
          id?: string
          promotion_family_key: string
          suppression_reason?: string | null
          user_id: string
        }
        Update: {
          artifact_id?: string | null
          contract_snapshot_id?: string | null
          created_at?: string
          details?: Json
          event_type?: string
          id?: string
          promotion_family_key?: string
          suppression_reason?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intelligence_promotion_events_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "intelligence_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intelligence_promotion_events_contract_snapshot_id_fkey"
            columns: ["contract_snapshot_id"]
            isOneToOne: false
            referencedRelation: "intelligence_contract_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      llm_model_catalog: {
        Row: {
          created_at: string
          display_name: string
          enabled: boolean
          id: string
          input_price_per_1m_usd: number | null
          model_id: string
          output_price_per_1m_usd: number | null
          pricing_is_placeholder: boolean
          pricing_tier: string | null
          provider: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name: string
          enabled?: boolean
          id?: string
          input_price_per_1m_usd?: number | null
          model_id: string
          output_price_per_1m_usd?: number | null
          pricing_is_placeholder?: boolean
          pricing_tier?: string | null
          provider: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          enabled?: boolean
          id?: string
          input_price_per_1m_usd?: number | null
          model_id?: string
          output_price_per_1m_usd?: number | null
          pricing_is_placeholder?: boolean
          pricing_tier?: string | null
          provider?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      llm_usage_events: {
        Row: {
          cache_status: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          estimated_cost_usd: number | null
          feature: string
          id: string
          input_tokens: number | null
          latency_ms: number
          model_catalog_id: string | null
          model_id: string | null
          model_source: string | null
          output_tokens: number | null
          pricing_is_placeholder: boolean | null
          pricing_tier: string | null
          provider: string | null
          request_fingerprint: string | null
          status: string
          user_id: string
        }
        Insert: {
          cache_status?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          estimated_cost_usd?: number | null
          feature?: string
          id?: string
          input_tokens?: number | null
          latency_ms?: number
          model_catalog_id?: string | null
          model_id?: string | null
          model_source?: string | null
          output_tokens?: number | null
          pricing_is_placeholder?: boolean | null
          pricing_tier?: string | null
          provider?: string | null
          request_fingerprint?: string | null
          status: string
          user_id: string
        }
        Update: {
          cache_status?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          estimated_cost_usd?: number | null
          feature?: string
          id?: string
          input_tokens?: number | null
          latency_ms?: number
          model_catalog_id?: string | null
          model_id?: string | null
          model_source?: string | null
          output_tokens?: number | null
          pricing_is_placeholder?: boolean | null
          pricing_tier?: string | null
          provider?: string | null
          request_fingerprint?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "llm_usage_events_model_catalog_id_fkey"
            columns: ["model_catalog_id"]
            isOneToOne: false
            referencedRelation: "llm_model_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      llm_user_preferences: {
        Row: {
          active_model_id: string | null
          created_at: string
          feature: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          active_model_id?: string | null
          created_at?: string
          feature?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          active_model_id?: string | null
          created_at?: string
          feature?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "llm_user_preferences_active_model_id_fkey"
            columns: ["active_model_id"]
            isOneToOne: false
            referencedRelation: "llm_model_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      note_decisions: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_by_stakeholder_id: string | null
          decision_status: string
          id: string
          note_id: string
          summary: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_by_stakeholder_id?: string | null
          decision_status?: string
          id?: string
          note_id: string
          summary: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_by_stakeholder_id?: string | null
          decision_status?: string
          id?: string
          note_id?: string
          summary?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_decisions_decided_by_stakeholder_id_fkey"
            columns: ["decided_by_stakeholder_id"]
            isOneToOne: false
            referencedRelation: "stakeholders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "note_decisions_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
        ]
      }
      note_links: {
        Row: {
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          link_role: string
          note_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          link_role?: string
          note_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          link_role?: string
          note_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_links_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
        ]
      }
      note_tasks: {
        Row: {
          created_at: string
          id: string
          note_id: string
          relationship_type: string
          task_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          note_id: string
          relationship_type?: string
          task_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          note_id?: string
          relationship_type?: string
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_tasks_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "note_tasks_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      notes: {
        Row: {
          body_markdown: string
          created_at: string
          id: string
          last_reviewed_at: string | null
          note_type: string
          pinned: boolean
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body_markdown?: string
          created_at?: string
          id?: string
          last_reviewed_at?: string | null
          note_type: string
          pinned?: boolean
          status?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body_markdown?: string
          created_at?: string
          id?: string
          last_reviewed_at?: string | null
          note_type?: string
          pinned?: boolean
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      oauth_mcp_access_tokens: {
        Row: {
          client_id: string
          created_at: string
          expires_at: string
          id: string
          revoked_at: string | null
          scope: string
          token_hash: string
          user_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          expires_at: string
          id?: string
          revoked_at?: string | null
          scope: string
          token_hash: string
          user_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          revoked_at?: string | null
          scope?: string
          token_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_mcp_access_tokens_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "oauth_mcp_clients"
            referencedColumns: ["client_id"]
          },
        ]
      }
      oauth_mcp_authorization_codes: {
        Row: {
          client_id: string
          code_challenge: string
          code_challenge_method: string
          code_hash: string
          created_at: string
          expires_at: string
          id: string
          redirect_uri: string
          scope: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          client_id: string
          code_challenge: string
          code_challenge_method?: string
          code_hash: string
          created_at?: string
          expires_at: string
          id?: string
          redirect_uri: string
          scope: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          client_id?: string
          code_challenge?: string
          code_challenge_method?: string
          code_hash?: string
          created_at?: string
          expires_at?: string
          id?: string
          redirect_uri?: string
          scope?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_mcp_authorization_codes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "oauth_mcp_clients"
            referencedColumns: ["client_id"]
          },
        ]
      }
      oauth_mcp_clients: {
        Row: {
          client_id: string
          client_name: string | null
          created_at: string
          grant_types: string[]
          id: string
          metadata: Json
          redirect_uris: string[]
          response_types: string[]
          scope: string
          token_endpoint_auth_method: string
        }
        Insert: {
          client_id: string
          client_name?: string | null
          created_at?: string
          grant_types?: string[]
          id?: string
          metadata?: Json
          redirect_uris: string[]
          response_types?: string[]
          scope?: string
          token_endpoint_auth_method?: string
        }
        Update: {
          client_id?: string
          client_name?: string | null
          created_at?: string
          grant_types?: string[]
          id?: string
          metadata?: Json
          redirect_uris?: string[]
          response_types?: string[]
          scope?: string
          token_endpoint_auth_method?: string
        }
        Relationships: []
      }
      oauth_mcp_refresh_tokens: {
        Row: {
          client_id: string
          created_at: string
          expires_at: string
          id: string
          replaced_by_token_hash: string | null
          revoked_at: string | null
          scope: string
          token_hash: string
          user_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          expires_at: string
          id?: string
          replaced_by_token_hash?: string | null
          revoked_at?: string | null
          scope: string
          token_hash: string
          user_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          replaced_by_token_hash?: string | null
          revoked_at?: string | null
          scope?: string
          token_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_mcp_refresh_tokens_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "oauth_mcp_clients"
            referencedColumns: ["client_id"]
          },
        ]
      }
      plans: {
        Row: {
          applied_at: string | null
          created_at: string
          created_by: string
          id: string
          inputs_snapshot: Json
          plan_date: string
          plan_json: Json
          reasons_json: Json
          source: string
          status: string
        }
        Insert: {
          applied_at?: string | null
          created_at?: string
          created_by: string
          id?: string
          inputs_snapshot: Json
          plan_date: string
          plan_json: Json
          reasons_json: Json
          source?: string
          status?: string
        }
        Update: {
          applied_at?: string | null
          created_at?: string
          created_by?: string
          id?: string
          inputs_snapshot?: Json
          plan_date?: string
          plan_json?: Json
          reasons_json?: Json
          source?: string
          status?: string
        }
        Relationships: []
      }
      project_sections: {
        Row: {
          created_at: string
          id: string
          name: string
          project_id: string
          sort_order: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          project_id: string
          sort_order?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          project_id?: string
          sort_order?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_sections_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_status_updates: {
        Row: {
          blockers: string[]
          captured_for_date: string
          changes_today: string[]
          created_at: string
          id: string
          implementation_id: string | null
          model: string | null
          needs_decision: string | null
          next_step: string | null
          payload: Json | null
          project_id: string
          rag: Database["public"]["Enums"]["rag_status"] | null
          related_task_ids: string[]
          source: string
          summary: string
          updated_at: string
          user_id: string
        }
        Insert: {
          blockers?: string[]
          captured_for_date?: string
          changes_today?: string[]
          created_at?: string
          id?: string
          implementation_id?: string | null
          model?: string | null
          needs_decision?: string | null
          next_step?: string | null
          payload?: Json | null
          project_id: string
          rag?: Database["public"]["Enums"]["rag_status"] | null
          related_task_ids?: string[]
          source?: string
          summary: string
          updated_at?: string
          user_id: string
        }
        Update: {
          blockers?: string[]
          captured_for_date?: string
          changes_today?: string[]
          created_at?: string
          id?: string
          implementation_id?: string | null
          model?: string | null
          needs_decision?: string | null
          next_step?: string | null
          payload?: Json | null
          project_id?: string
          rag?: Database["public"]["Enums"]["rag_status"] | null
          related_task_ids?: string[]
          source?: string
          summary?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_status_updates_implementation_id_fkey"
            columns: ["implementation_id"]
            isOneToOne: false
            referencedRelation: "implementations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_status_updates_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_template_sections: {
        Row: {
          created_at: string
          id: string
          name: string
          sort_order: number
          template_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          sort_order?: number
          template_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          sort_order?: number
          template_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_template_sections_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "project_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      project_template_tasks: {
        Row: {
          blocker: boolean
          checklist_items: string[]
          created_at: string
          description: string | null
          id: string
          needs_review: boolean
          priority_score: number
          relative_due_days: number | null
          sort_order: number
          status: Database["public"]["Enums"]["task_status"]
          task_type: Database["public"]["Enums"]["task_type"]
          template_id: string
          template_section_id: string | null
          title: string
          updated_at: string
          user_id: string
          waiting_on: string | null
        }
        Insert: {
          blocker?: boolean
          checklist_items?: string[]
          created_at?: string
          description?: string | null
          id?: string
          needs_review?: boolean
          priority_score?: number
          relative_due_days?: number | null
          sort_order?: number
          status?: Database["public"]["Enums"]["task_status"]
          task_type?: Database["public"]["Enums"]["task_type"]
          template_id: string
          template_section_id?: string | null
          title: string
          updated_at?: string
          user_id: string
          waiting_on?: string | null
        }
        Update: {
          blocker?: boolean
          checklist_items?: string[]
          created_at?: string
          description?: string | null
          id?: string
          needs_review?: boolean
          priority_score?: number
          relative_due_days?: number | null
          sort_order?: number
          status?: Database["public"]["Enums"]["task_status"]
          task_type?: Database["public"]["Enums"]["task_type"]
          template_id?: string
          template_section_id?: string | null
          title?: string
          updated_at?: string
          user_id?: string
          waiting_on?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_template_tasks_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "project_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_template_tasks_template_section_id_fkey"
            columns: ["template_section_id"]
            isOneToOne: false
            referencedRelation: "project_template_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      project_templates: {
        Row: {
          created_at: string
          default_rag: Database["public"]["Enums"]["rag_status"]
          default_stage: Database["public"]["Enums"]["project_stage"]
          default_status_summary: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          default_rag?: Database["public"]["Enums"]["rag_status"]
          default_stage?: Database["public"]["Enums"]["project_stage"]
          default_status_summary?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          default_rag?: Database["public"]["Enums"]["rag_status"]
          default_stage?: Database["public"]["Enums"]["project_stage"]
          default_status_summary?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          created_at: string
          description: string | null
          id: string
          implementation_id: string | null
          name: string
          portfolio_rank: number
          rag: Database["public"]["Enums"]["rag_status"]
          servicenow_spm_id: string | null
          stage: Database["public"]["Enums"]["project_stage"]
          status_summary: string
          target_date: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          implementation_id?: string | null
          name: string
          portfolio_rank?: number
          rag?: Database["public"]["Enums"]["rag_status"]
          servicenow_spm_id?: string | null
          stage?: Database["public"]["Enums"]["project_stage"]
          status_summary?: string
          target_date?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          implementation_id?: string | null
          name?: string
          portfolio_rank?: number
          rag?: Database["public"]["Enums"]["rag_status"]
          servicenow_spm_id?: string | null
          stage?: Database["public"]["Enums"]["project_stage"]
          status_summary?: string
          target_date?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_implementation_id_fkey"
            columns: ["implementation_id"]
            isOneToOne: false
            referencedRelation: "implementations"
            referencedColumns: ["id"]
          },
        ]
      }
      sprints: {
        Row: {
          created_at: string
          end_date: string
          focus_implementation_id: string | null
          id: string
          name: string
          start_date: string
          theme: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          end_date: string
          focus_implementation_id?: string | null
          id?: string
          name: string
          start_date: string
          theme?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          end_date?: string
          focus_implementation_id?: string | null
          id?: string
          name?: string
          start_date?: string
          theme?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sprints_focus_implementation_id_fkey"
            columns: ["focus_implementation_id"]
            isOneToOne: false
            referencedRelation: "implementations"
            referencedColumns: ["id"]
          },
        ]
      }
      stakeholders: {
        Row: {
          context: Json
          created_at: string
          email: string | null
          id: string
          name: string
          notes: string | null
          organization: string | null
          role: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          context?: Json
          created_at?: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          organization?: string | null
          role?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          context?: Json
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          organization?: string | null
          role?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      status_updates: {
        Row: {
          created_at: string
          created_by: string
          id: string
          implementation_id: string
          related_task_ids: string[]
          update_text: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string
          id?: string
          implementation_id: string
          related_task_ids?: string[]
          update_text: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          implementation_id?: string
          related_task_ids?: string[]
          update_text?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "status_updates_implementation_id_fkey"
            columns: ["implementation_id"]
            isOneToOne: false
            referencedRelation: "implementations"
            referencedColumns: ["id"]
          },
        ]
      }
      task_checklist_items: {
        Row: {
          id: string
          is_done: boolean
          sort_order: number
          task_id: string
          text: string
          user_id: string
        }
        Insert: {
          id?: string
          is_done?: boolean
          sort_order?: number
          task_id: string
          text: string
          user_id: string
        }
        Update: {
          id?: string
          is_done?: boolean
          sort_order?: number
          task_id?: string
          text?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_checklist_items_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_comments: {
        Row: {
          content: string
          created_at: string
          id: string
          source: string
          task_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          source?: string
          task_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          source?: string
          task_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_comments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_dependencies: {
        Row: {
          created_at: string
          depends_on_commitment_id: string | null
          depends_on_task_id: string | null
          id: string
          is_resolved: boolean
          resolved_at: string | null
          task_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          depends_on_commitment_id?: string | null
          depends_on_task_id?: string | null
          id?: string
          is_resolved?: boolean
          resolved_at?: string | null
          task_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          depends_on_commitment_id?: string | null
          depends_on_task_id?: string | null
          id?: string
          is_resolved?: boolean
          resolved_at?: string | null
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_dependencies_blocked_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_dependencies_blocker_task_id_fkey"
            columns: ["depends_on_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_dependencies_depends_on_commitment_id_fkey"
            columns: ["depends_on_commitment_id"]
            isOneToOne: false
            referencedRelation: "commitments"
            referencedColumns: ["id"]
          },
        ]
      }
      task_status_transitions: {
        Row: {
          created_at: string
          from_status: string | null
          id: string
          task_id: string
          to_status: string
          transitioned_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          from_status?: string | null
          id?: string
          task_id: string
          to_status: string
          transitioned_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          from_status?: string | null
          id?: string
          task_id?: string
          to_status?: string
          transitioned_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_status_transitions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          actual_minutes: number | null
          base_priority: number
          blocker: boolean
          created_at: string
          description: string | null
          due_at: string | null
          estimate_source: Database["public"]["Enums"]["estimate_source"]
          estimated_minutes: number
          follow_up_at: string | null
          id: string
          implementation_id: string | null
          inbox_item_id: string | null
          needs_review: boolean
          pinned: boolean
          pinned_excerpt: string | null
          priority_score: number
          project_id: string | null
          recurrence: Json | null
          section_id: string | null
          source_type: string
          source_url: string | null
          sprint_id: string | null
          stakeholder_mentions: string[]
          status: Database["public"]["Enums"]["task_status"]
          tags: string[]
          task_type: Database["public"]["Enums"]["task_type"]
          title: string
          updated_at: string
          user_id: string
          waiting_on: string | null
        }
        Insert: {
          actual_minutes?: number | null
          base_priority?: number
          blocker?: boolean
          created_at?: string
          description?: string | null
          due_at?: string | null
          estimate_source?: Database["public"]["Enums"]["estimate_source"]
          estimated_minutes?: number
          follow_up_at?: string | null
          id?: string
          implementation_id?: string | null
          inbox_item_id?: string | null
          needs_review?: boolean
          pinned?: boolean
          pinned_excerpt?: string | null
          priority_score?: number
          project_id?: string | null
          recurrence?: Json | null
          section_id?: string | null
          source_type?: string
          source_url?: string | null
          sprint_id?: string | null
          stakeholder_mentions?: string[]
          status?: Database["public"]["Enums"]["task_status"]
          tags?: string[]
          task_type?: Database["public"]["Enums"]["task_type"]
          title: string
          updated_at?: string
          user_id: string
          waiting_on?: string | null
        }
        Update: {
          actual_minutes?: number | null
          base_priority?: number
          blocker?: boolean
          created_at?: string
          description?: string | null
          due_at?: string | null
          estimate_source?: Database["public"]["Enums"]["estimate_source"]
          estimated_minutes?: number
          follow_up_at?: string | null
          id?: string
          implementation_id?: string | null
          inbox_item_id?: string | null
          needs_review?: boolean
          pinned?: boolean
          pinned_excerpt?: string | null
          priority_score?: number
          project_id?: string | null
          recurrence?: Json | null
          section_id?: string | null
          source_type?: string
          source_url?: string | null
          sprint_id?: string | null
          stakeholder_mentions?: string[]
          status?: Database["public"]["Enums"]["task_status"]
          tags?: string[]
          task_type?: Database["public"]["Enums"]["task_type"]
          title?: string
          updated_at?: string
          user_id?: string
          waiting_on?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_implementation_id_fkey"
            columns: ["implementation_id"]
            isOneToOne: false
            referencedRelation: "implementations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_inbox_item_id_fkey"
            columns: ["inbox_item_id"]
            isOneToOne: false
            referencedRelation: "inbox_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "project_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_sprint_id_fkey"
            columns: ["sprint_id"]
            isOneToOne: false
            referencedRelation: "sprints"
            referencedColumns: ["id"]
          },
        ]
      }
      today_sync_events: {
        Row: {
          created_at: string
          demoted: number
          id: string
          promoted: number
          skipped_pinned: number
          synced_at: string
          task_ids: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          demoted?: number
          id?: string
          promoted?: number
          skipped_pinned?: number
          synced_at?: string
          task_ids?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          demoted?: number
          id?: string
          promoted?: number
          skipped_pinned?: number
          synced_at?: string
          task_ids?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_blocked_by_tasks: {
        Args: { p_task_id: string }
        Returns: {
          blocker: boolean
          dependency_id: string
          implementation_id: string
          implementation_name: string
          status: Database["public"]["Enums"]["task_status"]
          task_id: string
          title: string
        }[]
      }
      get_blocking_tasks: {
        Args: { p_task_id: string }
        Returns: {
          blocker: boolean
          dependency_id: string
          implementation_id: string
          implementation_name: string
          status: Database["public"]["Enums"]["task_status"]
          task_id: string
          title: string
        }[]
      }
      get_implementation_with_stats: {
        Args: { impl_id: string }
        Returns: {
          blockers_count: number
          created_at: string
          id: string
          keywords: string[]
          name: string
          next_action_id: string
          next_action_title: string
          next_milestone: string
          next_milestone_date: string
          phase: Database["public"]["Enums"]["impl_phase"]
          rag: Database["public"]["Enums"]["rag_status"]
          stakeholders: string[]
          status_summary: string
          target_date: string
          updated_at: string
          user_id: string
        }[]
      }
      get_today_tasks: {
        Args: { p_user_id: string }
        Returns: {
          due_at: string
          estimated_minutes: number
          implementation_name: string
          priority_score: number
          status: Database["public"]["Enums"]["task_status"]
          task_id: string
          title: string
        }[]
      }
      instantiate_project_template: {
        Args: {
          p_implementation_id?: string
          p_kickoff_date: string
          p_project_name?: string
          p_template_id: string
          p_user_id: string
        }
        Returns: {
          created_checklist_items: number
          created_sections: number
          created_tasks: number
          project_id: string
        }[]
      }
      prune_llm_usage_events: { Args: { p_max_age?: string }; Returns: number }
      sync_today_tasks: {
        Args: { p_task_ids: string[]; p_today?: string; p_user_id: string }
        Returns: {
          demoted: number
          promoted: number
          skipped_in_progress: number
          skipped_ineligible: number
          skipped_pinned: number
          sync_at: string
        }[]
      }
      upsert_project_template: {
        Args: {
          p_default_rag?: Database["public"]["Enums"]["rag_status"]
          p_default_stage?: Database["public"]["Enums"]["project_stage"]
          p_default_status_summary?: string
          p_description?: string
          p_is_active?: boolean
          p_name?: string
          p_sections?: Json
          p_tasks?: Json
          p_template_id?: string
          p_user_id: string
        }
        Returns: {
          checklist_item_count: number
          section_count: number
          task_count: number
          template_id: string
        }[]
      }
    }
    Enums: {
      commitment_direction: "ours" | "theirs"
      commitment_status: "Open" | "Done" | "Dropped"
      estimate_source: "default" | "llm" | "manual"
      impl_phase:
        | "Intake"
        | "Discovery"
        | "Design"
        | "Build"
        | "Test"
        | "Training"
        | "GoLive"
        | "Hypercare"
        | "Steady State"
        | "Sundown"
      project_stage:
        | "Proposed"
        | "Planned"
        | "Ready"
        | "In Progress"
        | "Blocked"
        | "Review"
        | "Done"
        | "On Hold"
        | "Cancelled"
      rag_status: "Green" | "Yellow" | "Red"
      task_status:
        | "Backlog"
        | "Planned"
        | "In Progress"
        | "Blocked/Waiting"
        | "Parked"
        | "Done"
      task_type:
        | "Ticket"
        | "MeetingPrep"
        | "FollowUp"
        | "Admin"
        | "Build"
        | "Task"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      commitment_direction: ["ours", "theirs"],
      commitment_status: ["Open", "Done", "Dropped"],
      estimate_source: ["default", "llm", "manual"],
      impl_phase: [
        "Intake",
        "Discovery",
        "Design",
        "Build",
        "Test",
        "Training",
        "GoLive",
        "Hypercare",
        "Steady State",
        "Sundown",
      ],
      project_stage: [
        "Proposed",
        "Planned",
        "Ready",
        "In Progress",
        "Blocked",
        "Review",
        "Done",
        "On Hold",
        "Cancelled",
      ],
      rag_status: ["Green", "Yellow", "Red"],
      task_status: [
        "Backlog",
        "Planned",
        "In Progress",
        "Blocked/Waiting",
        "Parked",
        "Done",
      ],
      task_type: [
        "Ticket",
        "MeetingPrep",
        "FollowUp",
        "Admin",
        "Build",
        "Task",
      ],
    },
  },
} as const

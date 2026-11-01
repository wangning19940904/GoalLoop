CREATE TABLE IF NOT EXISTS goals (
 id uuid PRIMARY KEY, title text NOT NULL, status text NOT NULL DEFAULT 'draft', version integer NOT NULL DEFAULT 1,
 spec jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 deadline_at timestamptz, stable_since timestamptz, report jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE goal_versions(goal_id uuid REFERENCES goals(id), version integer, spec jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(goal_id,version));
CREATE TABLE tasks(id uuid PRIMARY KEY,goal_id uuid NOT NULL REFERENCES goals(id),title text NOT NULL,resource text NOT NULL,status text NOT NULL DEFAULT 'ready',dependencies uuid[] NOT NULL DEFAULT '{}',attempts integer NOT NULL DEFAULT 0,progress text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX tasks_goal ON tasks(goal_id);
CREATE TABLE jobs(id uuid PRIMARY KEY,goal_id uuid NOT NULL REFERENCES goals(id),task_id uuid REFERENCES tasks(id),kind text NOT NULL,dedupe text NOT NULL,status text NOT NULL DEFAULT 'pending',due_at timestamptz NOT NULL DEFAULT now(),owner text,epoch integer NOT NULL DEFAULT 0,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,error text,created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX jobs_unique_live ON jobs(dedupe) WHERE status IN ('pending','running');
CREATE INDEX jobs_due ON jobs(due_at) WHERE status='pending';
CREATE TABLE runs(id uuid PRIMARY KEY,goal_id uuid NOT NULL REFERENCES goals(id),task_id uuid NOT NULL REFERENCES tasks(id),job_id uuid NOT NULL REFERENCES jobs(id),epoch integer NOT NULL,goal_version integer NOT NULL,runtime text NOT NULL,status text NOT NULL,token_hash text NOT NULL,session_id text,input_tokens bigint,output_tokens bigint,summary text,error text,started_at timestamptz NOT NULL DEFAULT now(),ended_at timestamptz);
CREATE INDEX runs_goal ON runs(goal_id);
CREATE TABLE human_tasks(id uuid PRIMARY KEY,goal_id uuid NOT NULL REFERENCES goals(id),task_id uuid REFERENCES tasks(id),goal_version integer NOT NULL,type text NOT NULL,dedupe text NOT NULL,title text NOT NULL,details jsonb NOT NULL DEFAULT '{}',status text NOT NULL DEFAULT 'pending',answer jsonb,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),answered_at timestamptz);
CREATE UNIQUE INDEX human_unique_pending ON human_tasks(dedupe) WHERE status='pending';
CREATE TABLE actions(id uuid PRIMARY KEY,goal_id uuid NOT NULL REFERENCES goals(id),task_id uuid NOT NULL REFERENCES tasks(id),goal_version integer NOT NULL,capability text NOT NULL,resource text NOT NULL,args jsonb NOT NULL,proposal_hash text NOT NULL UNIQUE,precondition jsonb NOT NULL,status text NOT NULL,approval_id uuid REFERENCES human_tasks(id),result jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE resource_locks(resource text PRIMARY KEY,action_id uuid NOT NULL REFERENCES actions(id));
CREATE TABLE evidence(id uuid PRIMARY KEY,goal_id uuid NOT NULL REFERENCES goals(id),task_id uuid REFERENCES tasks(id),goal_version integer NOT NULL,source text NOT NULL,body jsonb NOT NULL,satisfied boolean,missing boolean NOT NULL DEFAULT false,observed_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL);
CREATE INDEX evidence_goal ON evidence(goal_id,observed_at);
CREATE TABLE events(id bigserial PRIMARY KEY,goal_id uuid REFERENCES goals(id),type text NOT NULL,data jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX events_goal ON events(goal_id,id);
CREATE TABLE outbox(id uuid PRIMARY KEY,goal_id uuid NOT NULL REFERENCES goals(id),event_key text NOT NULL UNIQUE,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,due_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,error text,sent_at timestamptz);
CREATE TABLE simulator_nodes(goal_id uuid REFERENCES goals(id),id text NOT NULL,score integer NOT NULL,fault text NOT NULL,version integer NOT NULL DEFAULT 1,stale boolean NOT NULL DEFAULT false,observed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(goal_id,id));
CREATE TABLE simulator_operations(action_id uuid PRIMARY KEY REFERENCES actions(id),result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());

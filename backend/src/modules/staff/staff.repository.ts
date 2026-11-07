/* Staff module — repository.

   All `staff_terminals` SQL lives here. The SELECT column list is explicit:
   there is no `SELECT *`, so a future column can never accidentally travel to
   a response. `pin_env_var` is a variable NAME, not a credential. */

import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import type {
  CreateStaffInput,
  StaffRepositoryPort,
  StaffSchemaPresence,
  StaffTerminalRow,
  StaffTerminalRole,
  UpdateStaffInput,
} from "./staff.types.js";

const STAFF_COLUMNS = `id, device_label, role, is_active, pin_env_var, created_at`;

export class StaffRepository implements StaffRepositoryPort {
  private readonly db: DbPort;

  constructor(db: DbPort) {
    this.db = db;
  }

  async findTerminal(staffId: string): Promise<StaffTerminalRow | null> {
    const res = await this.db.query<StaffTerminalRow>(
      `SELECT ${STAFF_COLUMNS}
         FROM staff_terminals
        WHERE id = $1`,
      [staffId],
    );
    return res.rows[0] ?? null;
  }

  async findActiveByRole(role: StaffTerminalRole): Promise<StaffTerminalRow | null> {
    const res = await this.db.query<StaffTerminalRow>(
      `SELECT ${STAFF_COLUMNS}
         FROM staff_terminals
        WHERE role = $1 AND is_active = true
        ORDER BY created_at, id
        LIMIT 1`,
      [role],
    );
    return res.rows[0] ?? null;
  }

  async listTerminals(): Promise<StaffTerminalRow[]> {
    const res = await this.db.query<StaffTerminalRow>(
      `SELECT ${STAFF_COLUMNS}
         FROM staff_terminals
        ORDER BY created_at, id`,
    );
    return res.rows;
  }

  async createTerminal(input: Required<CreateStaffInput>): Promise<StaffTerminalRow | null> {
    const res = await this.db.query<StaffTerminalRow>(
      `INSERT INTO staff_terminals (device_label, role, pin_env_var)
       VALUES ($1, $2, $3)
       RETURNING ${STAFF_COLUMNS}`,
      [input.device_label, input.role, input.pin_env_var],
    );
    return res.rows[0] ?? null;
  }

  /* COALESCE carries the patch: `false` and `""` are legitimate values that
     must win over the stored one, so every omitted field is passed as NULL. */
  async updateTerminal(
    staffId: string,
    input: UpdateStaffInput,
  ): Promise<StaffTerminalRow | null> {
    const res = await this.db.query<StaffTerminalRow>(
      `UPDATE staff_terminals
          SET device_label = COALESCE($2, device_label),
              role         = COALESCE($3, role),
              is_active    = COALESCE($4, is_active),
              pin_env_var  = COALESCE($5, pin_env_var)
        WHERE id = $1
        RETURNING ${STAFF_COLUMNS}`,
      [
        staffId,
        input.device_label ?? null,
        input.role ?? null,
        input.is_active ?? null,
        input.pin_env_var ?? null,
      ],
    );
    return res.rows[0] ?? null;
  }

  async schemaObjects(): Promise<StaffSchemaPresence> {
    const res = await this.db.query<{ terminals: boolean; role_constraint: boolean }>(
      `SELECT to_regclass('public.staff_terminals') IS NOT NULL AS terminals,
              EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'staff_terminals_role_check'
              ) AS role_constraint`,
    );

    const row = res.rows[0];
    const present: string[] = [];
    const missing: string[] = [];
    for (const [name, exists] of [
      ["staff_terminals", row?.terminals === true],
      ["staff_terminals.role_check", row?.role_constraint === true],
    ] as const) {
      if (exists) present.push(name);
      else missing.push(name);
    }
    return { present, missing };
  }
}

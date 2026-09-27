/**
 * Minimal stateful MySQL double covering exactly the statements issued by
 * `services/forms.js` and `services/documentation.js` (plus the `site_users`
 * lookup used when rendering a candidature).
 *
 * It exists so the real HTTP routes can be exercised end to end — a plain
 * recording pool cannot prove that a question is actually persisted or that a
 * documentation link survives the round trip to the database.
 */

const now = () => new Date('2026-03-01T12:00:00Z');

function emptyStore() {
  return {
    forms: [],
    formQuestions: [],
    formResponses: [],
    documentationBlocks: [],
    siteUsers: [],
    robloxLinks: [],
    strikes: [],
    cases: [],
  };
}

class FakeMysqlPool {
  constructor({ store = emptyStore(), clock = now } = {}) {
    this.store = store;
    this.clock = clock;
    this.autoIncrement = { forms: 0, form_questions: 0, form_responses: 0, documentation_blocks: 0 };
    this.log = [];
    this.transactionDepth = 0;
  }

  nextId(table) {
    this.autoIncrement[table] += 1;
    return this.autoIncrement[table];
  }

  async getConnection() {
    const pool = this;
    return {
      execute: (sql, params) => pool.execute(sql, params),
      beginTransaction: async () => { pool.transactionDepth += 1; },
      commit: async () => { pool.transactionDepth -= 1; },
      rollback: async () => { pool.transactionDepth -= 1; },
      release: () => {},
    };
  }

  async execute(rawSql, params = []) {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    this.log.push({ sql, params });

    if (/^CREATE TABLE/i.test(sql)) return [[]];
    if (/^ALTER TABLE/i.test(sql)) return [[]];

    // The forms bootstrap inspects the columns of an already-created table to
    // add `options` in place. The in-memory schema always has it.
    if (/^SHOW COLUMNS FROM form_questions/i.test(sql)) {
      const columns = [
        { Field: 'id' },
        { Field: 'form_id' },
        { Field: 'position' },
        { Field: 'label' },
        { Field: 'help_text' },
        { Field: 'field_type' },
        { Field: 'options' },
      ];
      return [columns];
    }

    // ------------------------------------------------------------------ forms
    if (/^INSERT INTO forms \(creator_discord_id, title, description, granted_role_id\)/i.test(sql)) {
      const [creator, title, description, grantedRoleId] = params;
      const row = {
        id: this.nextId('forms'),
        creator_discord_id: creator,
        title,
        description,
        granted_role_id: grantedRoleId,
        status: 'draft',
        published_at: null,
        created_at: this.clock(),
        updated_at: this.clock(),
      };
      this.store.forms.push(row);
      return [{ insertId: row.id, affectedRows: 1 }];
    }

    if (/^SELECT forms\.\*/i.test(sql)) {
      let rows = this.store.forms.map((form) => ({
        ...form,
        response_count: this.store.formResponses.filter((r) => r.form_id === form.id).length,
        pending_count: this.store.formResponses.filter((r) => r.form_id === form.id && r.status === 'pending').length,
      }));

      if (/forms\.status = \?/i.test(sql)) {
        rows = rows.filter((row) => row.status === params[0]);
      } else if (/forms\.creator_discord_id = \?/i.test(sql)) {
        const creator = params[0];
        rows = rows.filter((row) => row.creator_discord_id === creator);
      } else if (/forms\.id = \?/i.test(sql)) {
        rows = rows.filter((row) => row.id === Number(params[0]));
      }
      return [rows];
    }

    if (/^UPDATE forms SET title = \?/i.test(sql)) {
      const [title, description, grantedRoleId, formId, creator] = params;
      const form = this.store.forms.find((row) => row.id === Number(formId) && row.creator_discord_id === creator);
      if (!form) return [{ affectedRows: 0 }];
      Object.assign(form, { title, description, granted_role_id: grantedRoleId, updated_at: this.clock() });
      return [{ affectedRows: 1 }];
    }

    if (/^UPDATE forms SET status = \?, published_at/i.test(sql)) {
      const [status, formId, creator] = params;
      const form = this.store.forms.find((row) => row.id === Number(formId) && row.creator_discord_id === creator);
      if (!form) return [{ affectedRows: 0 }];
      Object.assign(form, { status, published_at: this.clock(), updated_at: this.clock() });
      return [{ affectedRows: 1 }];
    }

    if (/^UPDATE forms SET status = \? WHERE/i.test(sql)) {
      const [status, formId, creator] = params;
      const form = this.store.forms.find((row) => row.id === Number(formId) && row.creator_discord_id === creator);
      if (!form) return [{ affectedRows: 0 }];
      Object.assign(form, { status, updated_at: this.clock() });
      return [{ affectedRows: 1 }];
    }

    if (/^DELETE FROM forms WHERE/i.test(sql)) {
      const [formId, creator] = params;
      const index = this.store.forms.findIndex((row) => row.id === Number(formId) && row.creator_discord_id === creator);
      if (index === -1) return [{ affectedRows: 0 }];
      const [removed] = this.store.forms.splice(index, 1);
      this.store.formQuestions = this.store.formQuestions.filter((q) => q.form_id !== removed.id);
      this.store.formResponses = this.store.formResponses.filter((r) => r.form_id !== removed.id);
      return [{ affectedRows: 1 }];
    }

    if (/MAX\(published_at\)/i.test(sql)) {
      const published = this.store.forms
        .filter((form) => form.creator_discord_id === params[0] && form.published_at)
        .map((form) => form.published_at)
        .sort((a, b) => b - a);
      const last = published[0] ?? null;
      return [[{ last_published_at: last, minutes_since: last ? 10 : null }]];
    }

    // Support the new getPublishCooldownRemaining query without TIMESTAMPDIFF
    if (/SELECT MAX\(published_at\) AS last_published_at FROM forms/i.test(sql)) {
      const published = this.store.forms
        .filter((form) => form.creator_discord_id === params[0] && form.published_at)
        .map((form) => form.published_at)
        .sort((a, b) => b - a);
      const last = published[0] ?? null;
      return [[{ last_published_at: last }]];
    }

    // --------------------------------------------------------- form_questions
    if (/^SELECT id, form_id, position, label, help_text, field_type(, options)? FROM form_questions/i.test(sql)) {
      const rows = this.store.formQuestions
        .filter((row) => row.form_id === Number(params[0]))
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .map((row) => ({ options: null, ...row }));
      return [rows];
    }

    if (/^SELECT id FROM form_questions WHERE form_id = \?/i.test(sql)) {
      return [this.store.formQuestions
        .filter((row) => row.form_id === Number(params[0]))
        .map((row) => ({ id: row.id }))];
    }

    if (/^INSERT INTO form_questions/i.test(sql)) {
      const [formId, position, label, helpText, fieldType, options] = params;
      const row = {
        id: this.nextId('form_questions'),
        form_id: Number(formId),
        position,
        label,
        help_text: helpText,
        field_type: fieldType,
        options: options ?? null,
        created_at: this.clock(),
        updated_at: this.clock(),
      };
      this.store.formQuestions.push(row);
      return [{ insertId: row.id, affectedRows: 1 }];
    }

    if (/^UPDATE form_questions SET position/i.test(sql)) {
      const [position, label, helpText, fieldType, options, questionId, formId] = params;
      const row = this.store.formQuestions.find((q) => q.id === Number(questionId) && q.form_id === Number(formId));
      if (!row) return [{ affectedRows: 0 }];
      Object.assign(row, {
        position, label, help_text: helpText, field_type: fieldType, options: options ?? null, updated_at: this.clock(),
      });
      return [{ affectedRows: 1 }];
    }

    if (/^DELETE FROM form_questions WHERE id = \? AND form_id = \?$/i.test(sql)) {
      const [questionId, formId] = params;
      const index = this.store.formQuestions.findIndex((q) => q.id === Number(questionId) && q.form_id === Number(formId));
      if (index === -1) return [{ affectedRows: 0 }];
      this.store.formQuestions.splice(index, 1);
      return [{ affectedRows: 1 }];
    }

    // --------------------------------------------------------- form_responses
    if (/^SELECT form_responses\.\*, forms\.title AS form_title/i.test(sql)) {
      const [responseId, creator] = params;
      const rows = this.store.formResponses
        .filter((r) => r.id === Number(responseId) && this.formOwnedBy(r.form_id, creator))
        .map((r) => ({
          ...r,
          form_title: this.formById(r.form_id)?.title ?? null,
          form_creator: this.formById(r.form_id)?.creator_discord_id ?? null,
          granted_role_id: this.formById(r.form_id)?.granted_role_id ?? null,
        }));
      return [rows];
    }

    if (/^SELECT form_responses\.\*.*INNER JOIN forms/i.test(sql) && !/form_responses\.id = \?/i.test(sql)) {
      const [creator, maybeFormId] = params;
      let rows = this.store.formResponses
        .filter((r) => this.formOwnedBy(r.form_id, creator))
        .map((r) => ({ ...r, form_title: this.formById(r.form_id)?.title ?? null }));
      if (maybeFormId !== undefined) rows = rows.filter((r) => r.form_id === Number(maybeFormId));
      return [rows];
    }

    if (/^SELECT \* FROM form_responses WHERE form_id/i.test(sql)) {
      const [formId, applicantId, status] = params;
      const rows = this.store.formResponses
        .filter((r) => r.form_id === Number(formId) && r.applicant_discord_id === applicantId && r.status === status)
        .sort((a, b) => b.created_at - a.created_at);
      return [rows.map((r) => ({ ...r }))];
    }

    if (/^SELECT id FROM form_responses WHERE form_id/i.test(sql)) {
      const [formId, applicantId, status] = params;
      return [this.store.formResponses
        .filter((r) => r.form_id === Number(formId) && r.applicant_discord_id === applicantId && r.status === status)
        .map((r) => ({ id: r.id }))];
    }

    if (/^INSERT INTO form_responses/i.test(sql)) {
      const [formId, applicantId, status, answers] = params;
      const row = {
        id: this.nextId('form_responses'),
        form_id: Number(formId),
        applicant_discord_id: applicantId,
        status,
        answers,
        reviewer_discord_id: null,
        reviewed_at: null,
        created_at: this.clock(),
      };
      this.store.formResponses.push(row);
      return [{ insertId: row.id, affectedRows: 1 }];
    }

    if (/^UPDATE form_responses SET status/i.test(sql)) {
      const [status, reviewerId, responseId, creator] = params;
      const row = this.store.formResponses.find(
        (r) => r.id === Number(responseId) && r.status === 'pending' && this.formOwnedBy(r.form_id, creator),
      );
      if (!row) return [{ affectedRows: 0 }];
      Object.assign(row, { status, reviewer_discord_id: reviewerId, reviewed_at: this.clock() });
      return [{ affectedRows: 1 }];
    }

    // --------------------------------------------------- documentation_blocks
    if (/^SELECT id, position, block_type, title, content, url, updated_at FROM documentation_blocks ORDER BY/i.test(sql)) {
      const rows = this.store.documentationBlocks
        .slice()
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .map((row) => ({ ...row }));
      return [rows];
    }

    if (/COALESCE\(MAX\(position\), -1\) \+ 1 AS next_position/i.test(sql)) {
      const positions = this.store.documentationBlocks.map((b) => b.position);
      return [[{ next_position: positions.length ? Math.max(...positions) + 1 : 0 }]];
    }

    if (/^INSERT INTO documentation_blocks/i.test(sql)) {
      const [position, blockType, title, content, url] = params;
      const row = {
        id: this.nextId('documentation_blocks'),
        position,
        block_type: blockType,
        title,
        content,
        url,
        created_at: this.clock(),
        updated_at: this.clock(),
      };
      this.store.documentationBlocks.push(row);
      return [{ insertId: row.id, affectedRows: 1 }];
    }

    if (/^SELECT id, position, block_type, title, content, url, updated_at FROM documentation_blocks WHERE id/i.test(sql)) {
      const row = this.store.documentationBlocks.find((b) => b.id === Number(params[0]));
      return [row ? [{ ...row }] : []];
    }

    if (/^UPDATE documentation_blocks SET block_type/i.test(sql)) {
      const [blockType, title, content, url, blockId] = params;
      const row = this.store.documentationBlocks.find((b) => b.id === Number(blockId));
      if (!row) return [{ affectedRows: 0 }];
      Object.assign(row, { block_type: blockType, title, content, url, updated_at: this.clock() });
      return [{ affectedRows: 1 }];
    }

    if (/^UPDATE documentation_blocks SET position = \? WHERE id = \?/i.test(sql)) {
      const [position, blockId] = params;
      const row = this.store.documentationBlocks.find((b) => b.id === Number(blockId));
      if (!row) return [{ affectedRows: 0 }];
      row.position = position;
      return [{ affectedRows: 1 }];
    }

    if (/^UPDATE documentation_blocks SET position = position \+ 1 WHERE position >= \?/i.test(sql)) {
      const [from] = params;
      let affected = 0;
      for (const row of this.store.documentationBlocks) {
        if (row.position >= Number(from)) {
          row.position += 1;
          affected += 1;
        }
      }
      return [{ affectedRows: affected }];
    }

    if (/^SHOW COLUMNS FROM documentation_blocks/i.test(sql)) {
      // Mirrors a table created before the 'separator' type existed, so the
      // widening migration has something to fix.
      return [[{
        Field: 'block_type',
        Type: "enum('heading','text','link','bullets')",
      }]];
    }

    if (/^ALTER TABLE documentation_blocks\s+MODIFY COLUMN block_type/i.test(sql)) {
      return [[]];
    }

    if (/^DELETE FROM documentation_blocks WHERE id/i.test(sql)) {
      const index = this.store.documentationBlocks.findIndex((b) => b.id === Number(params[0]));
      if (index === -1) return [{ affectedRows: 0 }];
      this.store.documentationBlocks.splice(index, 1);
      return [{ affectedRows: 1 }];
    }

    if (/^SELECT id, position FROM documentation_blocks/i.test(sql)) {
      return [this.store.documentationBlocks
        .slice()
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .map((b) => ({ id: b.id, position: b.position }))];
    }

    // ------------------------------------------------- roblox_discord_links
    // Read by RobloxService when rendering the connected dashboard.
    if (/FROM roblox_links/i.test(sql) || /FROM roblox_discord_links/i.test(sql)) {
      // Handle both simple lookup and search query
      if (params[0] && params[0].startsWith('%')) {
        // Search query: WHERE ? = '%%' OR links.discord_user_id LIKE ? OR links.roblox_username LIKE ?
        const term = params[1]?.replace(/%/g, '') ?? '';
        return [this.store.robloxLinks
          ?.filter((l) => 
            term === '' || 
            l.discord_user_id.includes(term) || 
            (l.roblox_username && l.roblox_username.includes(term))
          )
          .map((l) => ({
            discord_user_id: l.discord_user_id,
            roblox_user_id: l.roblox_user_id,
            roblox_username: l.roblox_username,
            verification_rank: l.verification_rank,
            verified_at: l.verified_at,
          })) ?? []];
      }
      // Simple lookup by discord_user_id
      return [this.store.robloxLinks?.filter((l) => l.discord_user_id === params[0]) ?? []];
    }

    // ------------------------------------------------------------- site_users
    if (/FROM site_users/i.test(sql)) {
      // The batch lookup used by the responses inbox passes every requested id
      // as a placeholder, so the filter is driven by the params, not by one.
      const wanted = new Set(params.filter((value) => typeof value === 'string'));
      const rows = wanted.size
        ? this.store.siteUsers.filter((u) => wanted.has(u.discord_user_id))
        : this.store.siteUsers.filter((u) => u.discord_user_id === params[0]);
      return [rows.map((row) => ({ ...row }))];
    }

    // ------------------------------------------------- strikes (sanctions)
    if (/FROM strikes/i.test(sql)) {
      return [this.store.strikes?.filter((s) => s.discord_id === params[0]) ?? []];
    }

    // ------------------------------------------------- cases (sanctions)
    if (/FROM cases/i.test(sql)) {
      return [this.store.cases?.filter((c) => c.discord_id === params[0]) ?? []];
    }

    throw new Error(`FakeMysqlPool: unsupported statement -> ${sql}`);
  }

  formById(formId) {
    return this.store.forms.find((form) => form.id === Number(formId));
  }

  formOwnedBy(formId, creator) {
    return this.formById(formId)?.creator_discord_id === creator;
  }

  // Convenience accessors used by the assertions.
  questionsOf(formId) {
    return this.store.formQuestions
      .filter((q) => q.form_id === Number(formId))
      .sort((a, b) => a.position - b.position)
      .map((q) => ({
        id: q.id,
        label: q.label,
        help_text: q.help_text,
        field_type: q.field_type,
        options: q.options,
      }));
  }
}

export function createFakePool(options) {
  return new FakeMysqlPool(options);
}

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

export class ManualRunner implements AgentRunner {
  readonly name = 'manual';

  async runSprint(input: SprintRunInput): Promise<SprintRunResult> {
    // print sprint packet
    try {
      const packet = await readFile(input.sprint_packet_path, 'utf8');
      process.stdout.write('\n' + '═'.repeat(72) + '\n');
      process.stdout.write(packet);
      process.stdout.write('═'.repeat(72) + '\n\n');
    } catch {
      process.stdout.write(`[sprint packet not found at ${input.sprint_packet_path}]\n\n`);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      // status
      let status: 'completed' | 'blocked' | 'failed' | undefined;
      while (!status) {
        const raw = await prompt(rl, 'Sprint status? [completed / blocked / failed]: ');
        if (raw === 'completed' || raw === 'blocked' || raw === 'failed') {
          status = raw;
        } else {
          process.stdout.write('  Enter: completed, blocked, or failed\n');
        }
      }

      // summary
      const summary = await prompt(rl, 'One-line summary: ');

      // changed files
      const filesRaw = await prompt(rl, 'Changed files (space-separated, or enter to skip): ');
      const changed_files = filesRaw
        .split(' ')
        .map((f) => f.trim())
        .filter(Boolean);

      // autonomous mode review
      let review: SprintRunResult['review'] | undefined;
      if (input.mode === 'autonomous' && status === 'completed') {
        let verdict: 'accepted' | 'changes_requested' | 'rejected' | undefined;
        while (!verdict) {
          const raw = await prompt(
            rl,
            'Review verdict (autonomous mode)? [accepted / changes_requested / rejected]: ',
          );
          if (raw === 'accepted' || raw === 'changes_requested' || raw === 'rejected') {
            verdict = raw;
          } else {
            process.stdout.write('  Enter: accepted, changes_requested, or rejected\n');
          }
        }
        review = { verdict, findings: [] };
      }

      const base = {
        status,
        summary: summary || `sprint ${input.sprint_id} ${status}`,
        changed_files,
        needs_human: input.mode === 'assisted',
      };
      return review !== undefined ? { ...base, review } : base;
    } finally {
      rl.close();
    }
  }
}

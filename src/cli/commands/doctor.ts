import { runDoctor } from '../../core/doctor.ts';
import { print, type Command } from '../command.ts';
import { doctorText } from '../format.ts';

export const doctorCommands: Command[] = [
  {
    name: 'doctor',
    summary:
      'Check the djinni session, the jobs API and the djinni pages that the tool reads. ' +
      'The command sends only GET requests and opens no inbox conversation. It exits with 1 when a check fails.',
    async run(_values, _args, env) {
      const report = await runDoctor(env.ctx);
      print(env, report, () => doctorText(report));
      return report.ok ? 0 : 1;
    },
  },
];

import type { Options, Ora } from 'ora';

let spinnerInstance: Ora | null = null;

type OraFactory = (options?: string | Options) => Ora;

const getOraFactory = async (): Promise<OraFactory> => {
    const oraModule = (await import('ora')) as unknown as OraFactory & {
        default?: OraFactory;
    };

    return oraModule.default ?? oraModule;
};

const getSpinner = async () => {
    if (spinnerInstance) {
        return spinnerInstance;
    }

    const createOra = await getOraFactory();

    spinnerInstance = createOra({
        spinner: {
            interval: 200,
            frames: ['▰▱▱▱▱▱▱', '▰▰▱▱▱▱▱', '▰▰▰▱▱▱▱', '▰▰▰▰▱▱▱', '▰▰▰▰▰▱▱', '▰▰▰▰▰▰▱', '▰▰▰▰▰▰▰'],
        },
    });

    return spinnerInstance;
};

const spinner = {
    start: async (text?: string) => (await getSpinner()).start(text),
    stop: () => {
        if (spinnerInstance) {
            spinnerInstance.stop();
        }
    },
};

export default spinner;

import { connectDatabase } from '@infrastructure/db/connectDatabase';
import type { AppConfig } from '@config/appConfig';

export default class DatabaseBootstrap {
    constructor(private readonly deps: { appConfig: AppConfig }) {}

    async connect() {
        await connectDatabase(this.deps.appConfig);
    }
}

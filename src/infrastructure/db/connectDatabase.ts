import mongoose from 'mongoose';
import type { AppConfig } from '@config/appConfig';

export const connectDatabase = async (config: AppConfig) => mongoose.connect(config.mongoUri);

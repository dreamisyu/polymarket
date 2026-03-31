import mongoose from 'mongoose';
import type { RuntimeConfig } from '@config/runtimeConfig';

export const connectDatabase = async (config: RuntimeConfig) => mongoose.connect(config.mongoUri);

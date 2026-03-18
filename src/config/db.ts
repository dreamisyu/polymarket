import mongoose from 'mongoose';
import { ENV } from './env';

const connectDB = async () => mongoose.connect(ENV.MONGO_URI);

export default connectDB;

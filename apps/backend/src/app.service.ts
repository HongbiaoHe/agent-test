import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  getApiHello(): { message: string; timestamp: string } {
    return {
      message: 'Hello from NestJS backend 👋',
      timestamp: new Date().toISOString(),
    };
  }
}

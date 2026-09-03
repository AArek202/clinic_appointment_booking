import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator';

@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Public()
  @Get()
  async check(@Res() response: Response): Promise<void> {
    try {
      await this.dataSource.query('SELECT 1');
      response.status(HttpStatus.OK).json({ status: 'ok', database: 'up' });
    } catch {
      // 503 rather than 500: the process is alive but must not receive traffic.
      // nginx and compose both route on this.
      response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ status: 'error', database: 'down' });
    }
  }
}

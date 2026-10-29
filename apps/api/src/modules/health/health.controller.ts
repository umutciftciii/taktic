import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ReadinessService } from './readiness.service';

const SERVICE = 'taktic-api';

@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /**
   * Liveness: the process is up and answering. Deliberately independent of
   * the database (see ReadinessService).
   */
  @Get()
  getHealth() {
    return {
      status: 'ok',
      service: SERVICE,
    };
  }

  /**
   * Readiness (OBS-READY-001): 200 while the database answers, 503 while it
   * does not. The container healthcheck and the deploy smoke use this one.
   */
  @Get('ready')
  async getReadiness() {
    const report = await this.readiness.check();
    if (!report.ready) {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        service: SERVICE,
        database: report.database,
      });
    }
    return {
      status: 'ready',
      service: SERVICE,
      database: report.database,
      migrations: { applied: report.appliedMigrations },
    };
  }
}

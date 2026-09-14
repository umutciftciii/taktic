import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { CreateRequestReportDto } from './dto/create-request-report.dto';
import { RequestReportsService } from './request-reports.service';

@Controller('providers/:providerId/requests/:requestId/reports')
@UseGuards(AuthGuard, ProviderAccessGuard)
export class ProviderRequestReportsController {
  constructor(@Inject(RequestReportsService) private readonly reports: RequestReportsService) {}

  @Post()
  create(@Param('providerId') providerId: string, @Param('requestId') requestId: string, @Body() dto: CreateRequestReportDto) {
    return this.reports.createForProvider(providerId, requestId, dto);
  }
}

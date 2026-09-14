import { ConflictException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProvidersService } from '../providers/providers.service';
import { CreateRequestReportDto } from './dto/create-request-report.dto';
import {
  REPORT_ALREADY_EXISTS_CODE, REPORT_MAX_PER_PROVIDER_PER_DAY, REPORT_RATE_LIMITED_CODE,
} from './request-reports.constants';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class RequestReportsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProvidersService) private readonly providers: ProvidersService,
  ) {}

  /**
   * A provider may report exactly what they may see — the same predicate the
   * discovery screen and the offer path apply, so a report can never confirm
   * the existence of a request the caller was not shown.
   */
  async createForProvider(providerId: string, requestId: string, dto: CreateRequestReportDto) {
    await this.providers.ensureProviderCanSeeRequest(providerId, requestId);

    const since = new Date(Date.now() - DAY_MS);
    const today = await this.prisma.serviceRequestReport.count({
      where: { reporterProviderId: providerId, createdAt: { gte: since } },
    });
    if (today >= REPORT_MAX_PER_PROVIDER_PER_DAY) {
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests', code: REPORT_RATE_LIMITED_CODE, message: 'Günlük bildirim sınırına ulaştınız.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const note = dto.note?.trim() || null;
    try {
      const report = await this.prisma.serviceRequestReport.create({
        data: { requestId, reporterProviderId: providerId, reason: dto.reason, note },
        select: { id: true, reason: true, createdAt: true },
      });
      return report;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT, error: 'Conflict', code: REPORT_ALREADY_EXISTS_CODE,
          message: 'Bu talebi zaten bildirdiniz.',
        });
      }
      throw error;
    }
  }
}

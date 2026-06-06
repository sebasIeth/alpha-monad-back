import { Module } from '@nestjs/common';
import { SaidService } from './said.service';

@Module({
  providers: [SaidService],
  exports: [SaidService],
})
export class SaidModule {}

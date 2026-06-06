import { IsObject, IsString, MinLength, MaxLength, IsIn, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

class PersonaDto {
  @IsString() @MinLength(1) @MaxLength(30) name: string;
  @IsString() @MaxLength(20) avatar: string;
  @IsIn(['aggressive', 'balanced', 'defensive']) vibe: 'aggressive' | 'balanced' | 'defensive';
}

export class CreateManagedAgentDto {
  @IsObject() @Type(() => PersonaDto) persona: PersonaDto;
  @IsOptional() @IsString() @MaxLength(60) model?: string;
}

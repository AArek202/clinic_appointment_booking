import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthUserResolver } from '../auth-user.resolver';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtPayload } from '../jwt-payload.interface';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly resolver: AuthUserResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(
        header.slice('Bearer '.length),
      );
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    (request as Request & { user: unknown }).user =
      await this.resolver.resolve(payload);
    return true;
  }
}

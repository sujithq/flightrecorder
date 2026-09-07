FROM node:26-bookworm-slim AS web
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts/build-web.mjs scripts/build-web.mjs
COPY src/FlightRecorder.Web/ src/FlightRecorder.Web/
RUN npm run build:web

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS base
RUN mkdir /data && chown "$APP_UID:$APP_UID" /data && chmod 700 /data
USER $APP_UID
WORKDIR /app
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
ENV FlightRecorder__Storage__DataDirectory=/data

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src
COPY NuGet.Config ./
COPY ["src/FlightRecorder.Api/FlightRecorder.Api.csproj", "src/FlightRecorder.Api/"]
RUN dotnet restore "src/FlightRecorder.Api/FlightRecorder.Api.csproj"
COPY src/FlightRecorder.Api/ src/FlightRecorder.Api/
COPY --from=web /web/src/FlightRecorder.Api/wwwroot/ src/FlightRecorder.Api/wwwroot/
RUN dotnet publish "src/FlightRecorder.Api/FlightRecorder.Api.csproj" \
    --configuration $BUILD_CONFIGURATION \
    --output /app/publish \
    --no-restore \
    /p:UseAppHost=false

FROM base AS final
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "FlightRecorder.Api.dll"]

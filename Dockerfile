FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS base
USER $APP_UID
WORKDIR /app
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src
COPY ["src/FlightRecorder.Api/FlightRecorder.Api.csproj", "src/FlightRecorder.Api/"]
RUN dotnet restore "src/FlightRecorder.Api/FlightRecorder.Api.csproj"
COPY src/FlightRecorder.Api/ src/FlightRecorder.Api/
RUN dotnet publish "src/FlightRecorder.Api/FlightRecorder.Api.csproj" \
    --configuration $BUILD_CONFIGURATION \
    --output /app/publish \
    --no-restore \
    /p:UseAppHost=false

FROM base AS final
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "FlightRecorder.Api.dll"]

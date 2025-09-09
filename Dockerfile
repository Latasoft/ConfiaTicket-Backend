FROM node:18-alpine

WORKDIR /app

# Copiar archivos de configuración
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma/

# Instalar dependencias
RUN npm install

# Copiar código fuente
COPY . .

# Generar cliente Prisma
RUN npx prisma generate

# Compilar TypeScript
RUN npm run build

# Exponer puerto
EXPOSE 4000

# Comando para iniciar la aplicación
CMD ["npm", "start"]

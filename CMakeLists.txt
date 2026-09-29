cmake_minimum_required(VERSION 3.16)
project(asciisweeper C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(-Wall -Wextra)

find_package(Curses REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)

set(COMMON_SRC src/board.c src/net_io.c)

add_executable(asciisweeper src/main.c src/client_net.c ${COMMON_SRC})
target_include_directories(asciisweeper PRIVATE ${CURSES_INCLUDE_DIR})
target_link_libraries(asciisweeper PRIVATE ${CURSES_LIBRARIES} OpenSSL::SSL OpenSSL::Crypto)

add_executable(asciisweeper-server src/server.c ${COMMON_SRC})
target_link_libraries(asciisweeper-server PRIVATE OpenSSL::SSL OpenSSL::Crypto Threads::Threads)

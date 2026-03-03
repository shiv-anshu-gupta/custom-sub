cmake_minimum_required(VERSION 3.16)
project(sv_subscriber VERSION 1.0.0 LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# ============================================================================
# Source Files
# ============================================================================

set(DECODER_SOURCES
    src/asn1_ber_decoder.cc
    src/sv_decoder_impl.cc
    src/sv_subscriber.cc
    src/sv_capture_impl.cc
    src/sv_highperf.cc
    src/sv_phasor.cc
    src/sv_phasor_csv.cc
)

set(INCLUDE_DIRS
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

# ============================================================================
# Platform-specific link libraries (for npcap/pcap capture layer)
# ============================================================================

if(WIN32)
    set(PLATFORM_LIBS iphlpapi ws2_32)
else()
    find_library(PCAP_LIB pcap)
    if(PCAP_LIB)
        set(PLATFORM_LIBS ${PCAP_LIB})
    else()
        set(PLATFORM_LIBS "")
        message(WARNING "libpcap not found - capture will not work on this platform")
    endif()
endif()

# ============================================================================
# Build as static library (for Tauri Rust FFI)
# ============================================================================

add_library(sv_subscriber_static STATIC ${DECODER_SOURCES})
target_include_directories(sv_subscriber_static PUBLIC ${INCLUDE_DIRS})
target_link_libraries(sv_subscriber_static PRIVATE ${PLATFORM_LIBS})

# Also build as shared library (for dynamic loading / testing)
add_library(sv_subscriber_shared SHARED ${DECODER_SOURCES})
target_include_directories(sv_subscriber_shared PUBLIC ${INCLUDE_DIRS})
target_link_libraries(sv_subscriber_shared PRIVATE ${PLATFORM_LIBS})
set_target_properties(sv_subscriber_shared PROPERTIES OUTPUT_NAME "sv_subscriber")

# ============================================================================
# Test executable
# ============================================================================

add_executable(sv_decoder_test test/sv_decoder_test.cc)
target_link_libraries(sv_decoder_test PRIVATE sv_subscriber_static)
target_include_directories(sv_decoder_test PRIVATE ${INCLUDE_DIRS})

# Capture test - standalone console app to verify npcap capture works
add_executable(sv_capture_test test/sv_capture_test.cc)
target_link_libraries(sv_capture_test PRIVATE sv_subscriber_static ${PLATFORM_LIBS})
target_include_directories(sv_capture_test PRIVATE ${INCLUDE_DIRS})

# ============================================================================
# Install
# ============================================================================

install(TARGETS sv_subscriber_static sv_subscriber_shared
    ARCHIVE DESTINATION lib
    LIBRARY DESTINATION lib
    RUNTIME DESTINATION bin
)

install(FILES 
    include/sv_decoder.h
    include/asn1_ber_decoder.h
    include/sv_capture.h
    include/sv_highperf.h
    include/sv_phasor_csv.h
    DESTINATION include
)

message(STATUS "SV Subscriber native library configured")
message(STATUS "  Build type: ${CMAKE_BUILD_TYPE}")
message(STATUS "  Install prefix: ${CMAKE_INSTALL_PREFIX}")
